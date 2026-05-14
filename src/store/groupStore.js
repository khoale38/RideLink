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
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === peer.id);
      const merged = {
        connectionState: 'connecting',
        speaking: false,
        ...existing,
        ...peer,
      };
      return [...prev.filter((p) => p.id !== peer.id), merged];
    });
  }, []);

  const removePeer = useCallback((id) => {
    setPeers((prev) => prev.filter((p) => p.id !== id));
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

  const reset = useCallback(() => {
    setMyId(null);
    setPeers([]);
    setMuted(false);
  }, []);

  return {
    myName, setMyName,
    myId, setMyId,
    peers, addPeer, removePeer, setPeerSpeaking, setPeerConnectionState,
    role, setRole,
    connected, setConnected,
    muted, setMuted,
    reset,
  };
}
