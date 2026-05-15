import { useRef, useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { SignalingClient } from '../services/SignalingClient';
import { WebRTCManager } from '../services/WebRTCManager';
import { startSignalingServer, stopSignalingServer, SIGNALING_PORT } from '../services/SignalingServer';
import {
  getGatewayIP,
  requestLocationPermission,
  requestMicPermission,
  scanForRideLinkHotspot,
  connectToHotspot,
} from '../services/HotspotManager';
import { startIntercomService, stopIntercomService } from '../services/IntercomService';
import { startLocalHotspot, stopLocalHotspot } from '../services/LocalHotspot';
import { logger } from '../services/logger';

export function useIntercom(store, { onKicked } = {}) {
  // Latest onKicked callback kept in a ref so signaling handlers (bound once
  // per session) always see the current value without forcing a reconnect.
  const onKickedRef = useRef(onKicked);
  useEffect(() => { onKickedRef.current = onKicked; });
  const signalingRef = useRef(null);
  const rtcRef = useRef(null);
  const hostingRef = useRef(false);
  // Live 0..1 local mic level from WebRTC getStats. iOS useVOX polls this
  // because it can't open a parallel mic capture; Android ignores it and
  // reads PCM frames directly from RNAudioRecord instead.
  const localLevelRef = useRef(0);
  const [localStream, setLocalStream] = useState(null);

  const leaveGroup = useCallback(() => {
    // Disconnect signaling FIRST so any in-flight handlers (offer/answer/ice)
    // can't call into a half-destroyed WebRTC manager.
    try { signalingRef.current?.disconnect(); } catch (_) { /* ignore */ }
    try { rtcRef.current?.destroy(); } catch (_) { /* ignore */ }
    if (hostingRef.current) {
      try { stopSignalingServer(); } catch (_) { /* ignore */ }
      hostingRef.current = false;
    }
    stopIntercomService();
    stopLocalHotspot();
    rtcRef.current = null;
    signalingRef.current = null;
    setLocalStream(null);
    // Single canonical reset — clears role, connected, peers, hotspot info,
    // self-speaking, and mute together.
    store.reset?.();
  }, [store]);

  const hostGroup = useCallback(async (name, password) => {
    try {
      const micOk = await requestMicPermission();
      if (!micOk) throw new Error('Microphone permission denied');

      store.setRole('host');
      store.setMyName(name);
      store.setHotspotPassword?.(password);

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

      // Resolve the password the signaling server will require. For the
      // Android auto-hotspot path we use the OS-generated password set on the
      // store above; otherwise fall back to the user-supplied value.
      const sharedPassword =
        (Platform.OS === 'android' && store.hotspotPassword) || password;
      if (!sharedPassword) throw new Error('Hotspot password is required');

      hostingRef.current = true;
      startSignalingServer(sharedPassword, (event) => {
        if (event.type === 'peer_joined') {
          store.addPeer({ id: event.id, name: event.name, speaking: false });
        }
        if (event.type === 'peer_left') {
          store.removePeer(event.id);
        }
      });

      await _connect('127.0.0.1', name, store, { isHost: true, password: sharedPassword });
      // The host is "live" as soon as its own server is up and the loopback
      // signaling client has joined — don't make the user wait for a guest.
      store.setConnected(true);
    } catch (err) {
      leaveGroup();
      throw err;
    }
  }, [store, leaveGroup]);

  const joinGroup = useCallback(async (name, password) => {
    try {
      if (Platform.OS === 'android') {
        const locationOk = await requestLocationPermission();
        if (!locationOk) throw new Error('Location permission denied (needed to scan WiFi)');
      }
      const micOk = await requestMicPermission();
      if (!micOk) throw new Error('Microphone permission denied');

      store.setRole('guest');
      store.setMyName(name);

      if (Platform.OS === 'android') {
        const network = await scanForRideLinkHotspot();
        if (!network) throw new Error('No RideLink hotspot found nearby');
        const connected = await connectToHotspot(network.SSID, password);
        if (!connected) throw new Error(`Failed to connect to ${network.SSID}`);
      }

      await startIntercomService(`RideLink (${name})`);
      await _connect(getGatewayIP(), name, store, { password });
    } catch (err) {
      leaveGroup();
      throw err;
    }
  }, [store, leaveGroup]);

  // Manual mute — store flag only. App.tsx owns the audio track state.
  const toggleMute = useCallback(() => {
    store.setMuted(!store.muted);
  }, [store]);

  async function _connect(host, name, storeRef, opts = {}) {
    // IMPORTANT: register handlers BEFORE connect() so no incoming messages are dropped.
    const handlers = {};

    handlers.peer_list = ({ peers, yourId }) => {
      storeRef.setMyId(yourId);
      rtcRef.current?.setMyId(yourId);
      peers.forEach((p) => {
        storeRef.addPeer({ id: p.id, name: p.name, speaking: false });
        rtcRef.current?.callPeer(p.id);
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

    const client = new SignalingClient(host, SIGNALING_PORT, handlers);
    signalingRef.current = client;

    const rtc = new WebRTCManager(
      client,
      (peerId, speaking) => storeRef.setPeerSpeaking(peerId, speaking),
      (errInfo) => {
        logger.error('useIntercom', errInfo.error, { stage: errInfo.stage, peerId: errInfo.peerId });
      },
      (peerId, state) => storeRef.setPeerConnectionState(peerId, state),
      (speaking) => storeRef.setSelfSpeaking?.(speaking),
      (level) => { localLevelRef.current = level; },
    );
    rtcRef.current = rtc;

    await client.connect();
    const stream = await rtc.startLocalAudio();
    setLocalStream(stream);
    client.send({ type: 'join', name, isHost: !!opts.isHost, password: opts.password });
  }

  return { hostGroup, joinGroup, leaveGroup, toggleMute, localStream, localLevelRef };
}
