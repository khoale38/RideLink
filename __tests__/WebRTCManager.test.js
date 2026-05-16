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

test('pendingOffers dedupes by peer before setMyId', async () => {
  RTCPeerConnection.mockImplementation(() => makePc());
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  // 25 distinct peers: each kept (queue is bounded by N peers, not a magic cap).
  for (let i = 0; i < 25; i++) {
    await rtc._handleOffer({ from: `peer-${i}`, sdp: { type: 'offer', sdp: 'x' } });
  }
  expect(rtc.pendingOffers.length).toBe(25);
  // Re-offer from an existing peer supersedes the prior one — no duplicate entry.
  await rtc._handleOffer({ from: 'peer-3', sdp: { type: 'offer', sdp: 'x2' } });
  expect(rtc.pendingOffers.length).toBe(25);
  const entry = rtc.pendingOffers.find((m) => m.from === 'peer-3');
  expect(entry.sdp.sdp).toBe('x2');
  rtc.destroy();
});

test('ICE candidate arriving before remote SDP is buffered and flushed after setRemoteDescription', async () => {
  // Stand up a pc that reports no remoteDescription until setRemoteDescription
  // is called. Mirrors the polite-glare path where we tear down and rebuild,
  // and trickle ICE arrives in the gap before SDP is applied.
  const pc = makePc();
  pc.remoteDescription = null;
  pc.setRemoteDescription = jest.fn(async (sdp) => { pc.remoteDescription = sdp; });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a');
  // Seed the pc into the peer map by creating it directly.
  rtc._createPeerConnection('peer-b');

  // Candidate lands BEFORE the offer is handled.
  await rtc._handleIceCandidate({ from: 'peer-b', candidate: { candidate: 'c1', sdpMLineIndex: 0 } });
  expect(pc.addIceCandidate).not.toHaveBeenCalled();
  expect(rtc.pendingCandidates.get('peer-b')).toHaveLength(1);

  // Now the offer arrives — setRemoteDescription is called, then the
  // buffered candidate is replayed.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  expect(pc.setRemoteDescription).toHaveBeenCalled();
  expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
  expect(rtc.pendingCandidates.has('peer-b')).toBe(false);
  rtc.destroy();
});

test('offer watchdog tears down a pc that never receives an answer', async () => {
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  expect(rtc.peers.has('peer-a')).toBe(true);
  expect(rtc.offerWatchdogs.has('peer-a')).toBe(true);

  // Fast-forward past the watchdog window. The pc is still in
  // 'have-local-offer' → watchdog fires → peer removed.
  jest.advanceTimersByTime(16000);
  expect(pc.close).toHaveBeenCalled();
  expect(rtc.peers.has('peer-a')).toBe(false);
  rtc.destroy();
  jest.useRealTimers();
});

test('offer watchdog cleared when answer arrives', async () => {
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');

  await rtc._handleAnswer({ from: 'peer-a', sdp: { type: 'answer', sdp: 'ok' } });
  expect(rtc.offerWatchdogs.has('peer-a')).toBe(false);

  // Even past the deadline, no teardown happens.
  jest.advanceTimersByTime(20000);
  expect(pc.close).not.toHaveBeenCalled();
  expect(rtc.peers.has('peer-a')).toBe(true);
  rtc.destroy();
  jest.useRealTimers();
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

test('impolite glare re-arms offer watchdog so a slow polite-peer answer can still land', async () => {
  jest.useFakeTimers();
  const existing = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => existing);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z'); // impolite
  await rtc.callPeer('peer-b');
  // Advance most of the way through the original watchdog window.
  jest.advanceTimersByTime(14000);
  // Glare arrives — we should re-arm, not let the original timer fire.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });
  // The original 15s deadline has now passed.
  jest.advanceTimersByTime(2000);
  // pc must still be alive — the re-armed watchdog hasn't expired yet.
  expect(existing.close).not.toHaveBeenCalled();
  expect(rtc.peers.has('peer-b')).toBe(true);
  rtc.destroy();
  jest.useRealTimers();
});
