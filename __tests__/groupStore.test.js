import { renderHook, act } from '@testing-library/react-hooks';
import { useGroupStore } from '../src/store/groupStore';

// Minimal React.useCallback shim for the renderHook environment — handled
// automatically by react-hooks testing lib + the react-native jest preset.

test('addPeer preserves live state (connectionState + speaking) across a re-broadcast', () => {
  // peer_joined / peer_list payloads from the signaling server carry stale
  // defaults (speaking:false, no connectionState). When they re-broadcast
  // for an already-known peer (server bookkeeping, reconnect replay),
  // addPeer must NOT clobber the live state that the WebRTC layer has
  // since pushed in via setPeerSpeaking / setPeerConnectionState — that
  // would flicker the UI for one poll tick on every rebroadcast.
  const { result } = renderHook(() => useGroupStore());

  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.setPeerConnectionState('p1', 'connected'); });
  act(() => { result.current.setPeerSpeaking('p1', true); });
  // Server re-broadcasts peer_joined with stale defaults — must not flicker.
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice', speaking: false }); });

  expect(result.current.peers).toHaveLength(1);
  expect(result.current.peers[0]).toEqual(expect.objectContaining({
    id: 'p1',
    name: 'Alice',
    speaking: true,
    connectionState: 'connected',
  }));
});

test('addPeer updates name on re-broadcast (server is authoritative)', () => {
  // Live state is preserved across re-broadcasts, but `name` is the one
  // field the signaling server owns — a peer renaming themselves should
  // surface immediately even though connectionState is preserved.
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.setPeerConnectionState('p1', 'connected'); });
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice-Renamed' }); });
  expect(result.current.peers[0].name).toBe('Alice-Renamed');
  expect(result.current.peers[0].connectionState).toBe('connected');
});

test('reset clears role, peers, hotspot info, but preserves myName', () => {
  const { result } = renderHook(() => useGroupStore());

  act(() => {
    result.current.setMyName('Khoa');
    result.current.setRole('host');
    result.current.setConnected(true);
    result.current.setHotspotPassword('secret123');
    result.current.setHotspotSsid('RideLink-Khoa');
    result.current.addPeer({ id: 'p1', name: 'Alice' });
    result.current.setMuted(true);
  });

  act(() => { result.current.reset(); });

  expect(result.current.role).toBeNull();
  expect(result.current.connected).toBe(false);
  expect(result.current.peers).toEqual([]);
  expect(result.current.hotspotPassword).toBe('');
  expect(result.current.hotspotSsid).toBe('');
  expect(result.current.muted).toBe(false);
  // Name persists across reset by design.
  expect(result.current.myName).toBe('Khoa');
});

test('setPeerSpeaking preserves the peers array reference when value is unchanged', () => {
  // Hot-path perf: WebRTC's speaking poll fires every ~300ms; if setPeers
  // produced a new array on every tick (even when nothing changed), every
  // child of GroupScreen would re-render at 3+ Hz with N peers. The setter
  // must early-exit so React sees the same reference and skips the render.
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.setPeerSpeaking('p1', true); });
  const ref1 = result.current.peers;
  act(() => { result.current.setPeerSpeaking('p1', true); }); // same value
  expect(result.current.peers).toBe(ref1);
  act(() => { result.current.setPeerSpeaking('p1', false); }); // changed
  expect(result.current.peers).not.toBe(ref1);
});

test('setPeerConnectionState preserves the peers array reference when value is unchanged', () => {
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.setPeerConnectionState('p1', 'connected'); });
  const ref1 = result.current.peers;
  act(() => { result.current.setPeerConnectionState('p1', 'connected'); });
  expect(result.current.peers).toBe(ref1);
});

test('addPeer clamps a stale failed connectionState back to connecting on re-broadcast', () => {
  // If a peer_left was missed (rare server-side race), a peer_joined for
  // the same id must not surface the old 'failed' badge — the new pc is
  // about to negotiate from scratch.
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.setPeerConnectionState('p1', 'failed'); });
  expect(result.current.peers[0].connectionState).toBe('failed');
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  expect(result.current.peers[0].connectionState).toBe('connecting');
});

test('removePeer is a no-op for unknown ids', () => {
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.removePeer('ghost'); });
  expect(result.current.peers).toHaveLength(1);
  act(() => { result.current.removePeer('p1'); });
  expect(result.current.peers).toHaveLength(0);
});
