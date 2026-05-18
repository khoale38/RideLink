import { useRef, useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { SignalingClient } from '../services/SignalingClient';
import { WebRTCManager } from '../services/WebRTCManager';
import { startSignalingServer, stopSignalingServer, SIGNALING_PORT } from '../services/SignalingServer';
import {
  resolveGatewayIPVerbose,
  requestMicPermission,
} from '../services/HotspotManager';
import { startIntercomService, stopIntercomService } from '../services/IntercomService';
import { startLocalHotspot, stopLocalHotspot } from '../services/LocalHotspot';
import { logger } from '../services/logger';

export function useIntercom(store, { onKicked } = {}) {
  // Latest onKicked callback kept in a ref so signaling handlers (bound once
  // per session) always see the current value without forcing a reconnect.
  const onKickedRef = useRef(onKicked);
  useEffect(() => { onKickedRef.current = onKicked; }, [onKicked]);
  const signalingRef = useRef(null);
  const rtcRef = useRef(null);
  const hostingRef = useRef(false);
  // Serialises session lifecycle calls. Tapping "Host" immediately after
  // "Leave" used to race startSignalingServer against the still-closing
  // listener (EADDRINUSE) — the lock makes the second call wait for the
  // first to finish instead of relying on the bind-retry fallback.
  const sessionLockRef = useRef(Promise.resolve());
  // The lock chains via `.then(fn, fn)` so the next caller runs whether the
  // previous one fulfilled or rejected — a failed leave/host should not block
  // a subsequent join. `next` carries the *new* fn's rejection back to the
  // caller; `sessionLockRef` holds the swallowed-rejection version so the
  // chain itself never settles to a rejected state and future `.then(fn, fn)`
  // calls always fire.
  const withSessionLock = (fn) => {
    const next = sessionLockRef.current.then(() => fn(), () => fn());
    sessionLockRef.current = next.catch(() => {});
    return next;
  };
  const [localStream, setLocalStream] = useState(null);

  // Single recovery primitive. Every teardown path (user leave, hostGroup/
  // joinGroup error, _connect failure) routes through here so native
  // resources (foreground service, hotspot, signaling server) are always
  // awaited together — no callsite can leak by forgetting one.
  const _cleanupSession = useCallback(async ({ resetStore } = { resetStore: true }) => {
    // Disconnect signaling FIRST so any in-flight handlers (offer/answer/ice)
    // can't call into a half-destroyed WebRTC manager.
    // Release the iOS audio session we acquired for the group call. Safe on
    // Android (no-op) and idempotent if we never started it.
    try { InCallManager.setForceSpeakerphoneOn(false); } catch (_) { /* ignore */ }
    try { InCallManager.stop(); } catch (_) { /* ignore */ }
    try { signalingRef.current?.disconnect(); } catch (_) { /* ignore */ }
    // destroy() is async (it awaits any in-flight stats tick + replay chain
    // so trailing safeNotify calls can't fire into a torn-down store). Kick
    // it off here and include the promise in the awaited Promise.all below
    // so an immediate re-host doesn't race a still-running tick into the
    // unmounted React tree.
    let destroyRtc = Promise.resolve();
    try { destroyRtc = rtcRef.current?.destroy() ?? Promise.resolve(); } catch (_) { /* ignore */ }
    let stopServer = Promise.resolve();
    if (hostingRef.current) {
      try { stopServer = stopSignalingServer(); } catch (_) { /* ignore */ }
      hostingRef.current = false;
    }
    rtcRef.current = null;
    signalingRef.current = null;
    setLocalStream(null);
    if (resetStore) {
      // Single canonical reset — clears role, connected, peers, hotspot info,
      // self-speaking, and mute together. Run synchronously so the UI flips
      // immediately even though native teardown below is async.
      store.reset?.();
    }
    // Await native teardown so an immediate re-host doesn't race a still-
    // running foreground service or a half-closed listening socket
    // (which would otherwise throw EADDRINUSE on the next bind).
    try {
      await Promise.all([
        destroyRtc,
        stopServer,
        stopIntercomService(),
        stopLocalHotspot(),
      ]);
    } catch (_) { /* best-effort */ }
  }, [store]);

  const leaveGroup = useCallback(() => withSessionLock(() => _cleanupSession()), [_cleanupSession]);

  const hostGroup = useCallback((name) => withSessionLock(async () => {
    try {
      const micOk = await requestMicPermission();
      if (!micOk) throw new Error('Microphone permission denied');

      // Configure AVAudioSession (PlayAndRecord + speaker) BEFORE getUserMedia.
      // Without this, iOS can hand back a track whose capture is silent because
      // the session category defaults to one that doesn't permit recording.
      // No-op on Android.
      try {
        InCallManager.start({ media: 'audio', auto: true });
        InCallManager.setForceSpeakerphoneOn(true);
      } catch (_) { /* best-effort — fall through and surface failure later */ }

      store.setRole('host');
      store.setMyName(name);

      // Start the foreground service BEFORE opening the mic so Android grants
      // continuous mic capture even if the user immediately locks the screen.
      await startIntercomService(`RideLink (${name})`);

      // Android: auto-start a LocalOnlyHotspot so the host doesn't need to flip
      // anything in Settings. The OS generates SSID/password; we push them
      // into the store so the QR code and banner show the real values.
      if (Platform.OS === 'android') {
        const info = await startLocalHotspot();
        if (info) {
          store.setHotspotSsid?.(info.ssid);
          store.setHotspotPassword?.(info.password);
        }
      }

      hostingRef.current = true;
      startSignalingServer((event) => {
        if (event.type === 'peer_joined') {
          store.addPeer({ id: event.id, name: event.name, speaking: false });
        }
        if (event.type === 'peer_left') {
          store.removePeer(event.id);
        }
      });

      await _connect('127.0.0.1', name, store, { isHost: true });
      // The host is "live" as soon as its own server is up and the loopback
      // signaling client has joined — don't make the user wait for a guest.
      store.setConnected(true);
    } catch (err) {
      await _cleanupSession();
      throw err;
    }
    // _connect is defined as a function declaration in the hook scope and
    // is stable across renders; including it in the deps would force the
    // ref-identity of hostGroup/joinGroup to churn and would invalidate
    // any downstream useEffect deps that watch them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, _cleanupSession]);

  const joinGroup = useCallback((name) => withSessionLock(async () => {
    try {
      const micOk = await requestMicPermission();
      if (!micOk) throw new Error('Microphone permission denied');

      // See hostGroup — configure iOS audio session for capture + speaker out.
      try {
        InCallManager.start({ media: 'audio', auto: true });
        InCallManager.setForceSpeakerphoneOn(true);
      } catch (_) { /* best-effort */ }

      store.setRole('guest');
      store.setMyName(name);

      // Unified flow on both platforms: the user joins the host's hotspot in
      // system WiFi settings first. We just resolve the live gateway from our
      // WiFi IP — works for Android host (LocalOnlyHotspot) and iOS host
      // (Personal Hotspot) alike. No SSID prefix scan, no programmatic
      // password join — Android's connectToProtectedSSID is unreliable on
      // modern releases anyway.
      const { gateway, source } = await resolveGatewayIPVerbose();
      if (source !== 'wifi') {
        throw new Error('Not connected to a RideLink hotspot. Connect to the host\'s WiFi first, then try again.');
      }

      await startIntercomService(`RideLink (${name})`);
      await _connect(gateway, name, store, {});
    } catch (err) {
      await _cleanupSession();
      throw err;
    }
    // See hostGroup above for the _connect dep rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, _cleanupSession]);

  // Manual mute — store flag only. App.tsx owns the audio track state.
  const toggleMute = useCallback(() => {
    store.setMuted(!store.muted);
  }, [store]);

  async function _connect(host, name, storeRef, opts = {}) {
    // IMPORTANT: register handlers BEFORE connect() so no incoming messages are dropped.
    const handlers = {};

    handlers.peer_list = ({ peers, yourId }) => {
      // Defensive shape check. The signaling server validates inbound, but we
      // don't trust it transitively — a buggy/older server or fuzzer could
      // hand back a malformed peers array and crash the forEach below.
      if (!Array.isArray(peers)) {
        logger.warn('useIntercom', 'peer_list: malformed peers payload', { type: typeof peers });
        return;
      }
      storeRef.setMyId(yourId);
      // Snapshot the manager identity for this pass: a `reconnecting` event
      // arriving mid-iteration calls rtcRef.current.resetPeers(), which nulls
      // myId and wipes the peer map. Any callPeer fired after that point
      // would race against the reset and add tracks to a soon-to-be-stale
      // pc. Capture the manager up-front and bail per-peer if it's been
      // swapped or cleared.
      const rtcAtStart = rtcRef.current;
      rtcAtStart?.setMyId(yourId);
      peers.forEach((p) => {
        if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') return;
        storeRef.addPeer({ id: p.id, name: p.name, speaking: false });
        if (rtcRef.current !== rtcAtStart) return; // reconnect swapped under us
        if (!rtcAtStart || rtcAtStart.myId !== yourId) return; // resetPeers ran
        rtcAtStart.callPeer(p.id);
      });
      storeRef.setConnected(true);
    };

    handlers.peer_joined = ({ id, name: peerName }) => {
      storeRef.addPeer({ id, name: peerName, speaking: false });
    };

    // Guests learn about departures only via this broadcast. We tear down both
    // the RTC connection and the store entry from one place to avoid handler
    // collisions on the shared `handlers` object.
    handlers.peer_left = ({ id }) => {
      rtcRef.current?.handlePeerLeft(id);
      storeRef.removePeer(id);
    };

    handlers.disconnected = () => {
      storeRef.setConnected(false);
    };

    handlers.reconnecting = () => {
      storeRef.setConnected(false);
      // Tear down all peer connections — the server will assign us a fresh
      // clientId on rejoin, so existing peers already saw our socket close
      // and tore down their side. Without this reset, callPeer would short-
      // circuit on the stale ids in our peer map and we'd come back silent.
      rtcRef.current?.resetPeers();
      // Drop the peer roster from the store too — peer_list will repopulate
      // it once the rejoin completes. Use clearPeers (a setter call) rather
      // than iterating storeRef.peers, which is the render-time snapshot
      // captured when _connect ran and would miss peers added since.
      storeRef.clearPeers?.();
    };

    handlers.reconnected = () => {
      storeRef.setConnected(true);
    };

    // Host sent "room_closed" — they intentionally tore down the group.
    // Tell the UI to bail back to Home; leaveGroup tears down our side.
    handlers.room_closed = () => {
      onKickedRef.current?.('host_closed_room');
    };

    // Reconnect attempts exhausted — host is probably gone for good.
    handlers.gave_up = () => {
      onKickedRef.current?.('connection_lost');
    };

    // Host's loopback client must NOT auto-reconnect: if the local server
    // ever drops, the host is already tearing down and a reconnect chase
    // would either kick the host via gave_up → onKicked('connection_lost')
    // or fight the in-flight teardown.
    const client = new SignalingClient(host, SIGNALING_PORT, handlers, {
      disableReconnect: !!opts.isHost,
    });
    signalingRef.current = client;

    const rtc = new WebRTCManager(
      client,
      (peerId, speaking) => storeRef.setPeerSpeaking(peerId, speaking),
      (errInfo) => {
        logger.error('useIntercom', errInfo.error, { stage: errInfo.stage, peerId: errInfo.peerId });
      },
      (peerId, state) => storeRef.setPeerConnectionState(peerId, state),
    );
    rtcRef.current = rtc;

    // If any step fails partway, fully tear down so a half-initialised
    // WebRTCManager (no local stream, stats PC not stood up) isn't left in
    // rtcRef — a later reconnect would short-circuit and the rider stays mute.
    try {
      await client.connect();
      const stream = await rtc.startLocalAudio();
      setLocalStream(stream);
      client.send({ type: 'join', name, isHost: !!opts.isHost });
    } catch (err) {
      // Tear down only what _connect constructed locally. The outer
      // hostGroup/joinGroup catch always runs _cleanupSession, so doing it
      // here too would double-stop the foreground service / hotspot /
      // signaling server. Idempotency saves us, but the duplicate calls
      // are wasted work — and a future non-idempotent teardown step would
      // be a silent footgun. We still null the refs so the outer cleanup
      // can't reach into a half-built manager.
      try { client.disconnect(); } catch (_) { /* ignore */ }
      try { await (rtc.destroy?.() ?? Promise.resolve()); } catch (_) { /* ignore */ }
      signalingRef.current = null;
      rtcRef.current = null;
      setLocalStream(null);
      throw err;
    }
  }

  // App.tsx routes VOX/mute decisions through here so the gate is applied
  // per-peer via sender.replaceTrack rather than on the source track itself.
  // Gating the source would zero out media-source audioLevel and deadlock VOX
  // (level stuck at 0 → never detects speech → gate never opens).
  const setTransmitting = useCallback((enabled) => {
    rtcRef.current?.setTransmitting?.(enabled);
  }, []);

  return { hostGroup, joinGroup, leaveGroup, toggleMute, localStream, setTransmitting };
}
