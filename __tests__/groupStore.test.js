import { renderHook, act } from '@testing-library/react-hooks';
import { useGroupStore } from '../src/store/groupStore';

// Minimal React.useCallback shim for the renderHook environment — handled
// automatically by react-hooks testing lib + the react-native jest preset.

test('addPeer merges existing peer, preserves connectionState', () => {
  const { result } = renderHook(() => useGroupStore());

  act(() => {
    result.current.addPeer({ id: 'p1', name: 'Alice', speaking: false });
  });
  act(() => {
    result.current.setPeerConnectionState('p1', 'connected');
  });
  act(() => {
    result.current.addPeer({ id: 'p1', name: 'Alice', speaking: true });
  });

  expect(result.current.peers).toHaveLength(1);
  expect(result.current.peers[0]).toEqual(expect.objectContaining({
    id: 'p1',
    name: 'Alice',
    speaking: true,
    connectionState: 'connected',
  }));
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

test('removePeer is a no-op for unknown ids', () => {
  const { result } = renderHook(() => useGroupStore());
  act(() => { result.current.addPeer({ id: 'p1', name: 'Alice' }); });
  act(() => { result.current.removePeer('ghost'); });
  expect(result.current.peers).toHaveLength(1);
  act(() => { result.current.removePeer('p1'); });
  expect(result.current.peers).toHaveLength(0);
});
