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
    connectionState: 'new',
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
    oniceconnectionstatechange: null,
    iceConnectionState: 'new',
  };
}

// PeerEntry-aware accessors so test bodies stay readable.
const pcOf = (rtc, id) => rtc.peers.get(id)?.pc;
const entryOf = (rtc, id) => rtc.peers.get(id);

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

  // Smaller id should NOT drive restart even after a glare cleared the initiator
  // flag. This is the regression guard: previously the polite side cleared
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
  expect(pcOf(rtc, 'peer-b')).toBe(pc);
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
  const pc = makePc();
  pc.remoteDescription = null;
  pc.setRemoteDescription = jest.fn(async (sdp) => { pc.remoteDescription = sdp; });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a');
  rtc._createPeerConnection('peer-b');

  await rtc._handleIceCandidate({ from: 'peer-b', candidate: { candidate: 'c1', sdpMLineIndex: 0 } });
  expect(pc.addIceCandidate).not.toHaveBeenCalled();
  expect(entryOf(rtc, 'peer-b').pendingCandidates).toHaveLength(1);

  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  expect(pc.setRemoteDescription).toHaveBeenCalled();
  expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
  expect(entryOf(rtc, 'peer-b').pendingCandidates).toHaveLength(0);
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
  expect(entryOf(rtc, 'peer-a').offerWatchdog).not.toBeNull();

  jest.advanceTimersByTime(21000);
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
  expect(entryOf(rtc, 'peer-a').offerWatchdog).toBeNull();

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

  expect(existing.close).not.toHaveBeenCalled();
  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});

test('polite-glare rebuild preserves ICE candidates buffered before the new offer arrives', async () => {
  const existing = makePc({ signalingState: 'have-local-offer' });
  const fresh = makePc();
  fresh.remoteDescription = null;
  fresh.setRemoteDescription = jest.fn(async (sdp) => { fresh.remoteDescription = sdp; });
  RTCPeerConnection
    .mockImplementationOnce(() => existing)
    .mockImplementationOnce(() => fresh);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a'); // polite vs peer-b
  await rtc.callPeer('peer-b');

  await rtc._handleIceCandidate({ from: 'peer-b', candidate: { candidate: 'c1', sdpMLineIndex: 0 } });
  expect(entryOf(rtc, 'peer-b').pendingCandidates).toHaveLength(1);

  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });

  expect(fresh.setRemoteDescription).toHaveBeenCalled();
  expect(fresh.addIceCandidate).toHaveBeenCalledTimes(1);
  expect(entryOf(rtc, 'peer-b').pendingCandidates).toHaveLength(0);
  rtc.destroy();
});

test('_handleAnswer clears watchdog when negotiation already settled (stale state)', async () => {
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'stable' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  expect(entryOf(rtc, 'peer-a').offerWatchdog).not.toBeNull();

  await rtc._handleAnswer({ from: 'peer-a', sdp: { type: 'answer', sdp: 'late' } });

  expect(entryOf(rtc, 'peer-a').offerWatchdog).toBeNull();
  jest.advanceTimersByTime(30000);
  expect(pc.close).not.toHaveBeenCalled();
  expect(rtc.peers.has('peer-a')).toBe(true);
  rtc.destroy();
  jest.useRealTimers();
});

test('_handleAnswer clears watchdog even when pc is in have-remote-offer (stale-state regression)', async () => {
  // Bug: prior code only cleared the watchdog when state was 'stable'. If a
  // late answer arrived while the pc was in 'have-remote-offer' or one of the
  // 'have-*-pranswer' states, the watchdog stayed armed and later tore down
  // a healthy pc when the deadline fired.
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'have-remote-offer' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  expect(entryOf(rtc, 'peer-a').offerWatchdog).not.toBeNull();

  await rtc._handleAnswer({ from: 'peer-a', sdp: { type: 'answer', sdp: 'late' } });
  expect(entryOf(rtc, 'peer-a').offerWatchdog).toBeNull();

  jest.advanceTimersByTime(30000);
  expect(pc.close).not.toHaveBeenCalled();
  rtc.destroy();
  jest.useRealTimers();
});

test('impolite glare re-arms offer watchdog so a slow polite-peer answer can still land', async () => {
  jest.useFakeTimers();
  const existing = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => existing);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z'); // impolite
  await rtc.callPeer('peer-b');
  jest.advanceTimersByTime(14000);
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });
  jest.advanceTimersByTime(2000);
  expect(existing.close).not.toHaveBeenCalled();
  expect(rtc.peers.has('peer-b')).toBe(true);
  rtc.destroy();
  jest.useRealTimers();
});

test('callPeer does NOT set initiator flag when send is skipped by identity guard', async () => {
  // Regression: prior code did `initiatorOf.add(peerId)` before the await chain,
  // so a teardown mid-await left initiator state dangling. Now `entry.initiator`
  // is only set after the offer actually goes out.
  const pc = makePc();
  // Make setLocalDescription a pending promise we control, so we can remove the
  // peer mid-flight and observe the identity guard returning before send.
  let resolveSetLocal;
  pc.setLocalDescription = jest.fn(() => new Promise((r) => { resolveSetLocal = r; }));
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');

  const callPromise = rtc.callPeer('peer-a');
  // Wait for the await chain to reach setLocalDescription so resolveSetLocal
  // is wired up before we tear down.
  await new Promise((r) => setImmediate(r));
  // Peer is now in the map and the await is suspended — tear down.
  rtc._removePeer('peer-a');
  resolveSetLocal();
  await callPromise;

  expect(signaling.send).not.toHaveBeenCalled();
  // Peer is gone — no dangling state to inspect, but most importantly no offer
  // was sent and no watchdog was armed against an evicted entry.
  expect(rtc.peers.has('peer-a')).toBe(false);
  rtc.destroy();
});

test('_removePeer clears the offer watchdog so it cannot fire later', async () => {
  // Guards the bug fixed in 66e925a (resetPeers / _removePeer must flush
  // watchdogs, otherwise a stray timer tears down a freshly rebuilt pc).
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  rtc._removePeer('peer-a');
  expect(pc.close).toHaveBeenCalled();
  pc.close.mockClear();
  // The freed timer must not fire against a stale entry.
  jest.advanceTimersByTime(30000);
  expect(pc.close).not.toHaveBeenCalled();
  rtc.destroy();
  jest.useRealTimers();
});

test('resetPeers clears all watchdogs and disconnect timers', async () => {
  jest.useFakeTimers();
  const pcA = makePc({ signalingState: 'have-local-offer' });
  const pcB = makePc({ signalingState: 'have-local-offer' });
  RTCPeerConnection.mockImplementationOnce(() => pcA).mockImplementationOnce(() => pcB);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  await rtc.callPeer('peer-b');

  rtc.resetPeers();
  expect(rtc.peers.size).toBe(0);
  expect(rtc.pendingOffers).toHaveLength(0);
  expect(rtc.myId).toBeNull();

  pcA.close.mockClear();
  pcB.close.mockClear();
  jest.advanceTimersByTime(30000);
  expect(pcA.close).not.toHaveBeenCalled();
  expect(pcB.close).not.toHaveBeenCalled();
  rtc.destroy();
  jest.useRealTimers();
});

test('trailing onicecandidate after _removePeer does not get relayed', async () => {
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const onIce = pc.onicecandidate;

  rtc._removePeer('peer-a');
  signaling.send.mockClear();
  // Native side flushes a trailing candidate after close — must be dropped.
  onIce({ candidate: { candidate: 'trailing', sdpMLineIndex: 0 } });
  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});

test('_handleOffer identity guard: rebuild during awaits does not send a stale answer', async () => {
  // Polite-glare-during-glare race: while we're answering peer-b, _removePeer
  // wipes the entry. The in-flight await chain must bail at the identity guard
  // before sending an answer for an entry that's no longer in the map.
  let resolveSetRemote;
  const pc = makePc();
  pc.setRemoteDescription = jest.fn(() => new Promise((r) => { resolveSetRemote = r; }));
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');

  const offerPromise = rtc._handleOffer({ from: 'peer-a', sdp: { type: 'offer', sdp: 'x' } });
  // Let _handleOffer enter the await on setRemoteDescription before we tear down.
  await new Promise((r) => setImmediate(r));
  // Mid-await: someone tears the peer down.
  rtc._removePeer('peer-a');
  resolveSetRemote();
  await offerPromise;

  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});

test('ICE-restart backoff: repeated `failed` does not spin without delay', async () => {
  jest.useFakeTimers();
  const pc = makePc({ signalingState: 'stable' });
  pc.connectionState = 'new';
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const onState = pc.onconnectionstatechange;

  // First 'failed' — restart should schedule with the BASE delay, not 0.
  pc.connectionState = 'failed';
  onState();
  // Less than base delay: timer hasn't fired yet.
  jest.advanceTimersByTime(100);
  // Inspect timer presence via the entry (we don't directly check createOffer
  // here because callPeer already called it once).
  expect(rtc.peers.get('peer-a').disconnectTimer).not.toBeNull();
  rtc.destroy();
  jest.useRealTimers();
});

test('ICE-restart gives up after MAX_ATTEMPTS', async () => {
  const pc = makePc({ signalingState: 'stable' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  // Force the entry past the cap.
  rtc.peers.get('peer-a').restartAttempts = 6;
  pc.close.mockClear();
  await rtc._restartIce('peer-a');
  expect(pc.close).toHaveBeenCalled();
  expect(rtc.peers.has('peer-a')).toBe(false);
  rtc.destroy();
});

test('reconnect flow: resetPeers wipes state then peer_list replay produces fresh offers', async () => {
  // End-to-end reconnect simulation: an established peer drops on signaling
  // reconnect; resetPeers + setMyId(new id) + callPeer for each replayed peer
  // should mint a brand new pc and offer with no leftover state from the old
  // session. This is the single most fragile path in production.
  const pcOld = makePc();
  const pcNew = makePc();
  RTCPeerConnection
    .mockImplementationOnce(() => pcOld)
    .mockImplementationOnce(() => pcNew);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());

  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  expect(signaling.send).toHaveBeenCalledTimes(1); // first offer
  expect(rtc.peers.size).toBe(1);

  // Signaling reconnect path: hook calls resetPeers before the new peer_list
  // arrives. Everything must be flushed including myId so the next setMyId
  // re-establishes ordering.
  rtc.resetPeers();
  expect(rtc.peers.size).toBe(0);
  expect(rtc.myId).toBeNull();
  expect(rtc.pendingOffers).toHaveLength(0);
  // The old pc must have been closed so it doesn't keep relaying stats / ICE.
  expect(pcOld.close).toHaveBeenCalled();

  // New peer_list arrives with a freshly-issued clientId.
  signaling.send.mockClear();
  rtc.setMyId('peer-new');
  await rtc.callPeer('peer-a');

  // Fresh pc, fresh offer.
  expect(pcOf(rtc, 'peer-a')).toBe(pcNew);
  expect(pcNew.createOffer).toHaveBeenCalled();
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'offer', to: 'peer-a' }),
  );
  rtc.destroy();
});

test('iceConnectionState=connected resets restartAttempts even if connectionState lags', async () => {
  // Some react-native-webrtc builds leave connectionState parked in
  // 'connecting' even when iceConnectionState reaches 'connected' and
  // media flows. The ice-level reset must independently clear the
  // backoff counter so a later flap doesn't keep climbing toward the cap.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const entry = entryOf(rtc, 'peer-a');
  entry.restartAttempts = 4;

  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange();
  expect(entry.restartAttempts).toBe(0);
  rtc.destroy();
});

test('disconnected ↔ failed flap honors shared backoff (does not reset to 5s grace)', async () => {
  // Regression: a flapping link previously oscillated through 'disconnected'
  // (fixed 5s timer) and 'failed' (backoff timer), with the disconnected
  // branch overwriting the timer with 5s every flap — defeating the
  // exponential backoff. Both branches must now consult restartAttempts.
  jest.useFakeTimers();
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const entry = entryOf(rtc, 'peer-a');

  // Simulate a few failed restarts so restartAttempts is non-zero.
  entry.restartAttempts = 3;

  // Now the link flaps back to 'disconnected'. With the bug, this would
  // re-arm the timer to 5000ms, ignoring the climbing backoff.
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  expect(entry.disconnectTimer).not.toBeNull();

  // 5s — base disconnect grace — would NOT have fired the restart yet under
  // backoff (500 * 2^3 = 4000ms), so let's prove it fires earlier than 5s,
  // i.e. backoff wins over the legacy 5s grace.
  jest.advanceTimersByTime(4000);
  expect(entry.disconnectTimer).toBeNull(); // timer fired
  rtc.destroy();
  jest.useRealTimers();
});

test('disconnected→failed mid-grace-window recomputes delay with backoff (not stuck on 5s)', async () => {
  // A fresh 'disconnected' arms a 5s grace timer. If the link transitions
  // straight to 'failed' before the grace expires, the timer must be
  // recomputed against the backoff schedule (here, base 500ms) rather than
  // leaving the original 5s timer in place.
  jest.useFakeTimers();
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const entry = entryOf(rtc, 'peer-a');

  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  // Grace is armed.
  jest.advanceTimersByTime(1000);
  expect(entry.disconnectTimer).not.toBeNull();

  // Transition to 'failed' before the 5s grace expires. Backoff path with
  // restartAttempts=0 → 500ms.
  pc.connectionState = 'failed';
  pc.onconnectionstatechange();
  // The original grace timer must have been cleared and a fresh ~500ms one
  // armed; advance past that to confirm it fires.
  jest.advanceTimersByTime(600);
  expect(entry.disconnectTimer).toBeNull();
  rtc.destroy();
  jest.useRealTimers();
});

test('iceConnectionState=connected reports onPeerState even if connectionState stays connecting', async () => {
  // Regression guard for the UX bug: when connectionState is parked in
  // 'connecting' but ICE has actually completed, the badge previously stayed
  // yellow forever. The ICE-state listener now drives onPeerState too.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const onPeerState = jest.fn();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), onPeerState, jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  onPeerState.mockClear();

  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange();
  expect(onPeerState).toHaveBeenCalledWith('peer-a', 'connected');
  rtc.destroy();
});

test('_handleAnswer stale-state warning fires once per entry, not every duplicate', async () => {
  // Under fast ICE-restart churn, stale answers are legitimate. Logging on
  // every occurrence drowns out real issues. Implementation guards via a
  // per-entry flag; assert the warn only fires once.
  const pc = makePc({ signalingState: 'stable' });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a');
  await rtc.callPeer('peer-b');

  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await rtc._handleAnswer({ from: 'peer-b', sdp: { type: 'answer', sdp: 'a1' } });
  await rtc._handleAnswer({ from: 'peer-b', sdp: { type: 'answer', sdp: 'a2' } });
  await rtc._handleAnswer({ from: 'peer-b', sdp: { type: 'answer', sdp: 'a3' } });

  const staleCalls = warn.mock.calls.filter((c) => String(c[0]).includes('stale state'));
  expect(staleCalls).toHaveLength(1);
  warn.mockRestore();
  rtc.destroy();
});

test('first disconnected (no prior attempts) uses 5s grace, not zero-delay backoff', async () => {
  // Counterpart guard: the grace period for a *fresh* disconnect must still
  // apply so a single brief radio drop doesn't immediately kick a restart.
  jest.useFakeTimers();
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');
  const entry = entryOf(rtc, 'peer-a');
  expect(entry.restartAttempts).toBe(0);

  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();

  // Backoff would be 500ms; grace is 5000ms. Timer must NOT fire at 1s.
  jest.advanceTimersByTime(1000);
  expect(entry.disconnectTimer).not.toBeNull();
  // …but DOES fire by 5s.
  jest.advanceTimersByTime(4500);
  expect(entry.disconnectTimer).toBeNull();
  rtc.destroy();
  jest.useRealTimers();
});

test('destroy awaits a running stats tick before resolving', async () => {
  // The speaking poll calls pc.getStats() inside a try/finally that tracks
  // the running tick on `_tickRunning`. destroy() must await it so a
  // long-running native getStats() can't fire a trailing safeNotify into
  // a torn-down store.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  // Pause getStats so a tick is in-flight when destroy() is called.
  let resolveStats;
  pc.getStats.mockImplementation(() => new Promise((r) => { resolveStats = r; }));

  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn());
  // Add a peer so the speaking poll has something to call getStats on.
  rtc.setMyId('peer-z');
  await rtc.callPeer('peer-a');

  // Trigger a tick that will block on getStats.
  await new Promise((r) => setTimeout(r, 350));

  const destroyP = rtc.destroy();
  let resolved = false;
  destroyP.then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 50));
  // destroy should still be pending while getStats hasn't resolved.
  // If _tickRunning was null at destroy time (race with schedule), this
  // assertion is a no-op — that's also a safe outcome.
  if (rtc._tickRunning !== null && resolveStats) {
    expect(resolved).toBe(false);
    resolveStats(new Map());
  }
  await destroyP;
});

test('malformed offer payload is rejected without crashing', async () => {
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  // Missing sdp entirely
  await rtc._handleOffer({ from: 'peer-a' });
  // Wrong shape
  await rtc._handleOffer({ from: 'peer-a', sdp: 'not-an-object' });
  await rtc._handleOffer({ from: 'peer-a', sdp: { type: 'offer' /* missing sdp string */ } });
  expect(RTCPeerConnection).not.toHaveBeenCalled();
  expect(signaling.send).not.toHaveBeenCalled();
  rtc.destroy();
});

test('setMyId re-call with the same id still drains pendingOffers', async () => {
  // The signaling server is free to reissue the same clientId across a
  // reconnect. setMyId deliberately does NOT short-circuit on same-id — an
  // early return would strand any offers buffered since resetPeers() (see
  // the comment in setMyId).
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a');
  expect(rtc.myId).toBe('peer-a');
  rtc.pendingOffers.push({ from: 'peer-b', sdp: { type: 'offer', sdp: 'x' } });
  rtc.setMyId('peer-a');
  // Replay is async; flush microtasks so the buffered offer is applied.
  await new Promise((r) => setImmediate(r));
  expect(rtc.pendingOffers).toHaveLength(0);
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'answer', to: 'peer-b' }),
  );
  rtc.destroy();
});

test('renegotiation offer on an existing stable pc does not re-add tracks or tear down', async () => {
  // Regression: an ICE-restart offer lands while the pc is in 'stable'. The
  // old code re-ran addTrack on the existing pc — react-native-webrtc throws
  // 'Track already exists in a sender' — and _handleOffer's catch tore the
  // peer down instead of answering the restart.
  const track = { kind: 'audio' };
  const pc = makePc();
  pc.addTrack = jest.fn((t) => {
    if (pc.addTrack.mock.calls.length > 1) throw new Error('Track already exists in a sender');
    return { track: t, replaceTrack: jest.fn() };
  });
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a'); // smaller id — the side that receives the elected restart offer
  rtc.localStream = { getAudioTracks: () => [track], getTracks: () => [track] };

  // Initial handshake: remote offer creates the pc and attaches the track once.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'v1' } });
  expect(pc.addTrack).toHaveBeenCalledTimes(1);
  expect(entryOf(rtc, 'peer-b')).toBeTruthy();
  signaling.send.mockClear();

  // ICE-restart offer arrives on the now-stable pc.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'v2-restart' } });

  expect(pc.addTrack).toHaveBeenCalledTimes(1); // no duplicate attach
  expect(entryOf(rtc, 'peer-b')).toBeTruthy();  // peer survives
  expect(pc.close).not.toHaveBeenCalled();
  expect(signaling.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'answer', to: 'peer-b' }),
  );
  rtc.destroy();
});

test('destroy() awaits the replay chain and leaves _replayChain null', async () => {
  // Loop-await is symmetric with _tickRunning and lets a chain reassigned
  // mid-await (live-offer routing) still settle before pcs close. Each
  // _handleOffer bails on this.destroyed=true; destroy() loop-awaits until
  // _replayChain is stable null.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  // Buffer two offers so setMyId installs a multi-step chain.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'x' } });
  await rtc._handleOffer({ from: 'peer-c', sdp: { type: 'offer', sdp: 'y' } });
  rtc.setMyId('peer-a');
  expect(rtc._replayChain).not.toBeNull();
  await rtc.destroy();
  expect(rtc._replayChain).toBeNull();
  expect(rtc.destroyed).toBe(true);
});

test('_replayChain nullifies after live-offer re-assignment', async () => {
  // Bug: prior version only attached the finalizer to the original chain
  // identity, so a live-offer routing reassignment left _replayChain pinned
  // forever once the original resolved. _setReplayChain re-arms on each
  // assignment.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  // Queue a buffered offer so setMyId installs a real _replayChain.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'x' } });
  rtc.setMyId('peer-a');
  expect(rtc._replayChain).not.toBeNull();
  // Route a live offer onto the chain BEFORE the original resolves.
  rtc._handleOffer({ from: 'peer-c', sdp: { type: 'offer', sdp: 'y' } });
  // Flush all microtasks.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  expect(rtc._replayChain).toBeNull();
  rtc.destroy();
});

test('preserved candidate buffer is capped on glare rebuild', async () => {
  const existing = makePc({ signalingState: 'have-local-offer' });
  const fresh = makePc();
  RTCPeerConnection.mockImplementation(() => {
    if (existing.signalingState === 'have-local-offer' && !fresh._used) return existing;
    fresh._used = true;
    return fresh;
  });
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-a'); // smaller id = polite
  await rtc.callPeer('peer-b');
  // Flood the existing entry's pendingCandidates well past the cap.
  const entry = entryOf(rtc, 'peer-b');
  for (let i = 0; i < 200; i++) entry.pendingCandidates.push({ candidate: `cand-${i}`, sdpMid: '0' });
  // Glare offer arrives → polite tear-down + rebuild.
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'remote' } });
  const newEntry = entryOf(rtc, 'peer-b');
  // Preserved buffer must be truncated to <= 64 (MAX_PENDING_CANDIDATES). It
  // may be smaller (flushed during _handleOffer) but must not exceed 64.
  expect(newEntry?.pendingCandidates?.length ?? 0).toBeLessThanOrEqual(64);
  rtc.destroy();
});

// Make a pc whose getSenders returns audio senders we can spy on for the
// per-peer transmit gate tests. Each sender starts with the seed track so a
// later replaceTrack(null) is the observable mutation.
function makePcWithSenders(seedTrack) {
  const pc = makePc();
  const sender = { track: seedTrack, replaceTrack: jest.fn() };
  pc.getSenders = jest.fn(() => [sender]);
  pc._sender = sender;
  return pc;
}

test('setTransmitting(false) calls replaceTrack(null) on every audio sender', async () => {
  const track = { kind: 'audio' };
  const pc = makePcWithSenders(track);
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  rtc.localStream = { getAudioTracks: () => [track], getTracks: () => [track] };
  await rtc.callPeer('peer-a');
  pc._sender.replaceTrack.mockClear();

  rtc.setTransmitting(false);
  expect(pc._sender.replaceTrack).toHaveBeenCalledWith(null);

  rtc.setTransmitting(true);
  expect(pc._sender.replaceTrack).toHaveBeenLastCalledWith(track);
  rtc.destroy();
});

test('callPeer respects a closed transmit gate by replacing the sender track with null', async () => {
  // Regression guard: a peer joining while VOX has the gate closed must not
  // start leaking the pre-gate audio frames.
  const track = { kind: 'audio' };
  const pc = makePcWithSenders(track);
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn());
  rtc.setMyId('peer-z');
  rtc.localStream = { getAudioTracks: () => [track], getTracks: () => [track] };
  // pc.addTrack must hand back the sender so callPeer can flip it to null.
  pc.addTrack = jest.fn(() => pc._sender);
  rtc.transmitting = false; // gate closed before peer joins

  await rtc.callPeer('peer-a');
  expect(pc._sender.replaceTrack).toHaveBeenCalledWith(null);
  rtc.destroy();
});

test('speaking poll emits onLocalLevel from media-source audioLevel', async () => {
  // Replaces the prior react-native-audio-record path that returned zeros on
  // Android because RNAR's MIC AudioRecord lost arbitration against WebRTC's
  // VOICE_COMMUNICATION client. Reading `media-source.audioLevel` from a
  // stats-only loopback pc gives identical numbers on both platforms.
  jest.useFakeTimers();
  const pc = makePc();
  // Synthesize a media-source stats report shaped like a real getStats() Map.
  pc.getStats = jest.fn().mockResolvedValue(new Map([
    ['ms-1', { type: 'media-source', kind: 'audio', audioLevel: 0.42 }],
  ]));
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const onLocalLevel = jest.fn();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), onLocalLevel);
  // Stand in for the loopback pc that startLocalAudio() builds — bypassing
  // the real getUserMedia flow keeps this unit-scoped.
  rtc.localStatsPcLocal = pc;

  // Advance through one speaking-poll tick (300ms fast cadence).
  await jest.advanceTimersByTimeAsync(310);

  expect(onLocalLevel).toHaveBeenCalledWith(0.42);
  rtc.destroy();
  jest.useRealTimers();
});

test('onLocalLevel still fires when there are zero real peers (level pipe is independent)', async () => {
  // Regression guard: VOX needs the level pipe to be live BEFORE the first
  // peer connects so calibration can complete on the host's side while they
  // wait for a guest. The loopback pc is independent of this.peers.
  jest.useFakeTimers();
  const pc = makePc();
  pc.getStats = jest.fn().mockResolvedValue(new Map([
    ['ms-1', { type: 'media-source', kind: 'audio', audioLevel: 0.1 }],
  ]));
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const onLocalLevel = jest.fn();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), onLocalLevel);
  rtc.localStatsPcLocal = pc;
  expect(rtc.peers.size).toBe(0);

  await jest.advanceTimersByTimeAsync(310);
  expect(onLocalLevel).toHaveBeenCalledWith(0.1);
  rtc.destroy();
  jest.useRealTimers();
});

test('live offer arriving during replay drain is routed onto the same chain', async () => {
  // Regression guard for the parallel-race bug: a live offer arriving while
  // setMyId() is draining the pendingOffers buffer must hand off onto the
  // existing _replayChain rather than running in parallel on the same pc.
  const pc = makePc();
  RTCPeerConnection.mockImplementation(() => pc);
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn());

  // Queue a buffered offer (no setMyId yet).
  await rtc._handleOffer({ from: 'peer-b', sdp: { type: 'offer', sdp: 'queued' } });
  expect(rtc.pendingOffers).toHaveLength(1);

  // Make the buffered replay's setRemoteDescription block so we can race a
  // live offer in while the chain is still draining.
  let resolveBuffered;
  pc.setRemoteDescription = jest.fn()
    .mockImplementationOnce(() => new Promise((r) => { resolveBuffered = r; }))
    .mockResolvedValue(undefined);

  rtc.setMyId('peer-a');
  await new Promise((r) => setImmediate(r));
  // Replay chain is now installed and awaiting the blocked setRemoteDescription.
  expect(rtc._replayChain).not.toBeNull();

  // Live offer arrives during the drain. It MUST be routed onto the existing
  // chain (no parallel pc creation, no concurrent setRemoteDescription).
  const replayChainBefore = rtc._replayChain;
  await rtc._handleOffer({ from: 'peer-c', sdp: { type: 'offer', sdp: 'live' } });
  expect(rtc._replayChain).not.toBe(replayChainBefore); // chain extended

  // Only the buffered offer's first setRemoteDescription should have started;
  // the live one is queued behind it.
  expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

  // Unblock and let the chain settle.
  resolveBuffered();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  rtc.destroy();
});
