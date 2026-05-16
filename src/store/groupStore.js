import { useState, useCallback } from 'react';

// Simple in-memory state — no Redux needed at this stage
export function useGroupStore() {
  const [myName, setMyName] = useState('');
  const [myId, setMyId] = useState(null);
  const [peers, setPeers] = useState([]); // [{ id, name, speaking }]
  const [role, setRole] = useState(null); // 'host' | 'guest'
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hotspotPassword, setHotspotPassword] = useState('');
  const [hotspotSsid, setHotspotSsid] = useState('');
  const [selfSpeaking, setSelfSpeaking] = useState(false);

  const addPeer = useCallback((peer) => {
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === peer.id);
      // Order matters: defaults < new peer payload < existing live state.
      // peer_joined / peer_list carry speaking:false by convention, so a
      // rejoin event would otherwise clobber a real speaking:true for one
      // poll tick (~300ms) and flicker the UI. Keeping `...existing` last
      // preserves the live speaking/connectionState until the WebRTC layer
      // updates them through their dedicated setters.
      const merged = {
        connectionState: 'connecting',
        speaking: false,
        ...peer,
        ...existing,
        // Always honor the latest name from the payload — that's the one
        // field the signaling server is authoritative about across rejoins.
        name: peer.name ?? existing?.name,
        id: peer.id,
      };
      return [...prev.filter((p) => p.id !== peer.id), merged];
    });
  }, []);

  const removePeer = useCallback((id) => {
    setPeers((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Drop every peer from the roster. Used by useIntercom on signaling
  // reconnect because iterating storeRef.peers would walk the stale render-
  // time snapshot captured by _connect and miss anyone added later.
  const clearPeers = useCallback(() => {
    setPeers([]);
  }, []);

  const setPeerSpeaking = useCallback((id, speaking) => {
    setPeers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, speaking } : p)),
    );
  }, []);

  const setPeerConnectionState = useCallback((id, connectionState) => {
    setPeers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, connectionState } : p)),
    );
  }, []);

  // Canonical full-reset: clear every field that varies per session. Called
  // once from useIntercom.leaveGroup so callers don't need to remember the
  // list of fields to clear individually.
  const reset = useCallback(() => {
    setMyId(null);
    setPeers([]);
    setMuted(false);
    setSelfSpeaking(false);
    setHotspotSsid('');
    setHotspotPassword('');
    setRole(null);
    setConnected(false);
    // myName is intentionally preserved across sessions so the user doesn't
    // have to re-type their rider name on the next group.
  }, []);

  return {
    myName, setMyName,
    myId, setMyId,
    peers, addPeer, removePeer, clearPeers, setPeerSpeaking, setPeerConnectionState,
    role, setRole,
    connected, setConnected,
    muted, setMuted,
    hotspotPassword, setHotspotPassword,
    hotspotSsid, setHotspotSsid,
    selfSpeaking, setSelfSpeaking,
    reset,
  };
}
