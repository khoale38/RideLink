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
