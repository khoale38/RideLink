import { useState, useCallback } from 'react';

/**
 * Public shape contract for the group store. App.tsx and the WebRTCManager
 * embed this — keep in sync if you add a setter below.
 *
 * @typedef {Object} Peer
 * @property {string} id
 * @property {string} name
 * @property {boolean} speaking
 * @property {'connecting'|'connected'|'failed'} [connectionState]
 *
 * @typedef {Object} GroupStore
 * @property {string} myName
 * @property {(name: string) => void} setMyName
 * @property {string|null} myId
 * @property {(id: string|null) => void} setMyId
 * @property {Peer[]} peers
 * @property {(peer: Partial<Peer> & {id: string, name: string}) => void} addPeer
 * @property {(id: string) => void} removePeer
 * @property {() => void} clearPeers
 * @property {(id: string, speaking: boolean) => void} setPeerSpeaking
 * @property {(id: string, state: 'connecting'|'connected'|'failed') => void} setPeerConnectionState
 * @property {'host'|'guest'|null} role
 * @property {(role: 'host'|'guest'|null) => void} setRole
 * @property {boolean} connected
 * @property {(c: boolean) => void} setConnected
 * @property {boolean} muted
 * @property {(m: boolean) => void} setMuted
 * @property {string} hotspotPassword
 * @property {(p: string) => void} setHotspotPassword
 * @property {string} hotspotSsid
 * @property {(s: string) => void} setHotspotSsid
 * @property {boolean} selfSpeaking
 * @property {(s: boolean) => void} setSelfSpeaking
 * @property {() => void} reset
 */

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
      // Re-joins must NOT inherit a stale 'failed' state. If a peer_left
      // was missed (rare server-side race), `...existing` would otherwise
      // surface the prior session's 'failed' badge until the new pc
      // handshake updates it. Clamp 'failed' back to 'connecting' on
      // every (re)broadcast — the WebRTC layer pushes the real state
      // through setPeerConnectionState within a tick of the new pc.
      const liveConnState = existing?.connectionState === 'failed'
        ? 'connecting'
        : (existing?.connectionState ?? 'connecting');
      const merged = {
        speaking: false,
        ...peer,
        ...existing,
        // Always honor the latest name from the payload — that's the one
        // field the signaling server is authoritative about across rejoins.
        name: peer.name ?? existing?.name,
        id: peer.id,
        connectionState: liveConnState,
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

  // Hot-path setters used by the WebRTC speaking-poll (~300ms cadence). Skip
  // the state update entirely when the value is unchanged so React doesn't
  // re-render the peer list on every tick — even an O(n) map+spread that
  // produces an equal-shape array still costs render passes across the
  // GroupScreen subtree. The early-exit "return prev" tells React to keep
  // the existing reference and bail.
  const setPeerSpeaking = useCallback((id, speaking) => {
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === id);
      if (!existing || existing.speaking === speaking) return prev;
      return prev.map((p) => (p.id === id ? { ...p, speaking } : p));
    });
  }, []);

  const setPeerConnectionState = useCallback((id, connectionState) => {
    setPeers((prev) => {
      const existing = prev.find((p) => p.id === id);
      if (!existing || existing.connectionState === connectionState) return prev;
      return prev.map((p) => (p.id === id ? { ...p, connectionState } : p));
    });
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
