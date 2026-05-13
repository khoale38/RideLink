import { useRef, useCallback, useState } from 'react';
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
  const [localStream, setLocalStream] = useState(null);

  const hostGroup = useCallback(async (name) => {
    await requestMicPermission();
    store.setRole('host');
    store.setMyName(name);

    startSignalingServer((event) => {
      if (event.type === 'peer_joined') store.addPeer({ id: event.id, name: event.name, speaking: false });
      if (event.type === 'peer_left') store.removePeer(event.id);
    });

    await _connect('127.0.0.1', name, store);
  }, [store]);

  const joinGroup = useCallback(async (name) => {
    await requestLocationPermission();
    await requestMicPermission();
    store.setRole('guest');
    store.setMyName(name);

    const network = await scanForRideLinkHotspot();
    if (network) await connectToHotspot(network.SSID);

    await _connect(getGatewayIP(), name, store);
  }, [store]);

  const leaveGroup = useCallback(() => {
    rtcRef.current?.destroy();
    signalingRef.current?.disconnect();
    if (store.role === 'host') stopSignalingServer();
    store.setConnected(false);
    store.setRole(null);
    setLocalStream(null);
    rtcRef.current = null;
    signalingRef.current = null;
  }, [store]);

  // Manual mute — overrides VOX gate
  const toggleMute = useCallback(() => {
    const stream = rtcRef.current?.localStream;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.enabled = store.muted; // flip
      store.setMuted(!store.muted);
    }
  }, [store]);

  async function _connect(host, name, storeRef) {
    const handlers = {};
    const client = new SignalingClient(host, SIGNALING_PORT, handlers);
    signalingRef.current = client;

    const rtc = new WebRTCManager(client, (peerId, _stream) => {
      storeRef.setPeerSpeaking(peerId, true);
    });
    rtcRef.current = rtc;

    await client.connect();
    const stream = await rtc.startLocalAudio();
    setLocalStream(stream);
    client.send({ type: 'join', name });

    handlers.peer_list = ({ peers, yourId }) => {
      storeRef.setMyId(yourId);
      peers.forEach((p) => {
        storeRef.addPeer({ id: p.id, name: p.name, speaking: false });
        rtc.callPeer(p.id);
      });
      storeRef.setConnected(true);
    };

    handlers.peer_joined = ({ id, name: peerName }) => {
      storeRef.addPeer({ id, name: peerName, speaking: false });
    };

    handlers.disconnected = () => {
      storeRef.setConnected(false);
    };
  }

  return { hostGroup, joinGroup, leaveGroup, toggleMute, localStream };
}
