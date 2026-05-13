import { useState, useCallback } from 'react';

// Simple in-memory state — no Redux needed at this stage
export function useGroupStore() {
  const [myName, setMyName] = useState('');
  const [myId, setMyId] = useState(null);
  const [peers, setPeers] = useState([]); // [{ id, name, speaking }]
  const [role, setRole] = useState(null); // 'host' | 'guest'
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);

  const addPeer = useCallback((peer) => {
    setPeers((prev) => [...prev.filter((p) => p.id !== peer.id), peer]);
  }, []);

  const removePeer = useCallback((id) => {
    setPeers((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const setPeerSpeaking = useCallback((id, speaking) => {
    setPeers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, speaking } : p)),
    );
  }, []);

  return {
    myName, setMyName,
    myId, setMyId,
    peers, addPeer, removePeer, setPeerSpeaking,
    role, setRole,
    connected, setConnected,
    muted, setMuted,
  };
}
