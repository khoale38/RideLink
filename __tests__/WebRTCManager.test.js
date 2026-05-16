/**
 * Unit tests for WebRTCManager glare / perfect-negotiation tie-break.
 *
 * The bug we're guarding against: if an `offer` arrives before
 * setMyId() has been called, the old code defaulted to "polite" and
 * both peers could end up polite simultaneously → no offer survives.
 * The fix queues offers until setMyId, then replays them so both sides
 * apply the same lexicographic tie-break.
 */

import { RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { WebRTCManager } from '../src/services/WebRTCManager';

function makeSignaling() {
  return {
    handlers: {},
    send: jest.fn(),
  };
}

function makePc({ signalingState = 'stable' } = {}) {
  return {
    signalingState,
    addTrack: jest.fn(),
    createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'x' }),
    createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: 'y' }),
    setLocalDescription: jest.fn().mockResolvedValue(undefined),
    setRemoteDescription: jest.fn().mockResolvedValue(undefined),
    addIceCandidate: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    getStats: jest.fn().mockResolvedValue(new Map()),
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  RTCSessionDescription.mockImplementation((init) => init);
});

test('offer received before setMyId is queued and replayed after', async () => {
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());

  // No setMyId yet — offer arrives during the race window.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  // Nothing should have happened yet: no peer connection created, no answer sent.
  expect(RTCPeerConnection).not.toHaveBeenCalled();
  expect(signaling.send).not.toHaveBeenCalled();
  expect(rtc.pendingOffers).toHaveLength(1);

  rtc.setMyId('peer-a');
  // Replay is async (setMyId fires _handleOffer without awaiting); flush microtasks.
  await new Promise((r) => setImmediate(r));

  expect(RTCPeerConnection).toHaveBeenCalledTimes(1);
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'answer', to: 'peer-b' }),
  );
  expect(rtc.pendingOffers).toHaveLength(0);
  rtc.destroy();
});

test('glare: lexicographically smaller id is polite and accepts remote offer', async () => {
  const existing = makePc({ signalingState: 'have-local-offer' });
  const fresh = makePc();
  RTCPeerConnection
    .mockImplementationOnce(() => existing) // initial callPeer
    .mockImplementationOnce(() => fresh);   // rebuilt after rollback
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a'); // 'peer-a' < 'peer-b' → we are polite
  await rtc.callPeer('peer-b');
  signaling.send.mockClear();

  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  // Polite side: existing pc is closed, new one created, answer sent.
  expect(existing.close).toHaveBeenCalled();
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'answer', to: 'peer-b' }),
  );
  rtc.destroy();
});

test('_restartIce: larger id drives restart, smaller id is silent', async () => {
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());

  // Larger id → drives restart. Use callPeer to seat the peer in the map.
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  signaling.send.mockClear();
  pc.createOffer.mockClear();

  await rtc._restartIce('peer-a');
  expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'offer', to: 'peer-a' }),
  );
  rtc.destroy();
});

test('_restartIce: smaller id stays silent (waits for peer to drive)', async () => {
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());

  // Smaller id should NOT drive restart even after a glare cleared initiatorOf.
  // This is the regression guard: previously the polite side cleared
  // initiatorOf on glare and then no one could restart ICE.
  rtc.setMyId('peer-a');
  await rtc.callPeer('peer-z');
  signaling.send.mockClear();
  pc.createOffer.mockClear();

  await rtc._restartIce('peer-z');
  expect(pc.createOffer).not.toHaveBeenCalled();
  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});

test('_handleAnswer: ignores answer when signalingState is not have-local-offer (stale answer should not tear down healthy pc)', async () => {
  // Reproduce: a late answer arrives after glare resolution swapped our local
  // offer out. The pc is now 'stable' (or 'have-remote-offer'). Old code
  // called setRemoteDescription unconditionally → InvalidStateError → pc torn
  // down. New behavior: log non-fatally, keep the pc.
  const pc = makePc({ signalingState: 'stable' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const onError = jest.fn();
  const rtc = new WebRTCManager(signaling, jest.fn(), onError, jest.fn(), jest.fn());
  rtc.setMyId('peer-a');
  await rtc.callPeer('peer-b');
  pc.setRemoteDescription.mockClear();

  await rtc._handleAnswer({ from: 'peer-b', sdp: { type: 'answer', sdp: 'late' } });

  expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  expect(pc.close).not.toHaveBeenCalled();
  expect(rtc.peers.get('peer-b')).toBe(pc);
  // Non-fatal: onError (fatal callback) is NOT invoked.
  expect(onError).not.toHaveBeenCalled();
  rtc.destroy();
});

test('pendingOffers is capped to prevent unbounded growth before setMyId', async () => {
  RTCPeerConnection.mockImplementation(() => makePc());
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  // Push more than the cap (16) of pre-setMyId offers.
  for (let i = 0; i < 25; i++) {
    await rtc._handleOffer({ from: `peer-${i}`, sdp: { type: 'offer', sdp: 'x' } });
  }
  expect(rtc.pendingOffers.length).toBeLessThanOrEqual(16);
  // FIFO: oldest dropped, newest retained.
  expect(rtc.pendingOffers[rtc.pendingOffers.length - 1].from).toBe('peer-24');
  rtc.destroy();
});

test('glare: lexicographically larger id is impolite and ignores incoming offer', async () => {
  const existing = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => existing);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z'); // 'peer-z' > 'peer-b' → we are impolite
  await rtc.callPeer('peer-b');
  signaling.send.mockClear();

  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  // Impolite side: existing pc untouched, no answer sent.
  expect(existing.close).not.toHaveBeenCalled();
  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});
