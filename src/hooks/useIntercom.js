import { useRef, useCallback, useState } from 'react';
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

export function useIntercom(store) {
  const signalingRef = useRef(null);
  const rtcRef = useRef(null);
  const hostingRef = useRef(false);
  const [localStream, setLocalStream] = useState(null);

  const leaveGroup = useCallback(() => {
    try { rtcRef.current?.destroy(); } catch (_) { /* ignore */ }
    try { signalingRef.current?.disconnect(); } catch (_) { /* ignore */ }
    if (hostingRef.current) {
      try { stopSignalingServer(); } catch (_) { /* ignore */ }
      hostingRef.current = false;
    }
    rtcRef.current = null;
    signalingRef.current = null;
    setLocalStream(null);
    store.setConnected(false);
    store.setRole(null);
    store.reset?.();
  }, [store]);

  const hostGroup = useCallback(async (name) => {
    try {
      const micOk = await requestMicPermission();
      if (!micOk) throw new Error('Microphone permission denied');

      store.setRole('host');
      store.setMyName(name);

      hostingRef.current = true;
      startSignalingServer((event) => {
        if (event.type === 'peer_joined') {
          store.addPeer({ id: event.id, name: event.name, speaking: false });
        }
        if (event.type === 'peer_left') {
          store.removePeer(event.id);
        }
      });

      await _connect('127.0.0.1', name, store);
    } catch (err) {
      leaveGroup();
      throw err;
    }
  }, [store, leaveGroup]);

  const joinGroup = useCallback(async (name) => {
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
        const connected = await connectToHotspot(network.SSID);
        if (!connected) throw new Error(`Failed to connect to ${network.SSID}`);
      }

      await _connect(getGatewayIP(), name, store);
    } catch (err) {
      leaveGroup();
      throw err;
    }
  }, [store, leaveGroup]);

  // Manual mute — store flag only. App.tsx owns the audio track state.
  const toggleMute = useCallback(() => {
    store.setMuted(!store.muted);
  }, [store]);

  async function _connect(host, name, storeRef) {
    // IMPORTANT: register handlers BEFORE connect() so no incoming messages are dropped.
    const handlers = {};

    handlers.peer_list = ({ peers, yourId }) => {
      storeRef.setMyId(yourId);
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

    const client = new SignalingClient(host, SIGNALING_PORT, handlers);
    signalingRef.current = client;

    const rtc = new WebRTCManager(
      client,
      (peerId) => storeRef.setPeerSpeaking(peerId, true),
      (errInfo) => {
        if (__DEV__) console.warn('[useIntercom] WebRTC error:', errInfo);
      },
      (peerId, state) => storeRef.setPeerConnectionState(peerId, state),
    );
    rtcRef.current = rtc;

    await client.connect();
    const stream = await rtc.startLocalAudio();
    setLocalStream(stream);
    client.send({ type: 'join', name });
  }

  return { hostGroup, joinGroup, leaveGroup, toggleMute, localStream };
}
