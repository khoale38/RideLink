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

test('_localStatsPc setup is bounded by MAX_BUILD_ATTEMPTS', async () => {
  // Constructor throws → _buildLocalStatsPc fails → _ensureLocalStatsPc retries.
  // After 3 failed attempts it must stop calling the constructor.
  RTCPeerConnection.mockImplementation(() => { throw new Error('native broken'); });
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.localStream = { getTracks: () => [] }; // bypass startLocalAudio

  await rtc._ensureLocalStatsPc();
  await rtc._ensureLocalStatsPc();
  await rtc._ensureLocalStatsPc();
  await rtc._ensureLocalStatsPc(); // should no-op
  await rtc._ensureLocalStatsPc(); // should no-op

  // First pc constructor throws → second is never reached this build, so
  // one call per attempt × MAX_BUILD_ATTEMPTS = 3.
  expect(RTCPeerConnection).toHaveBeenCalledTimes(3);
  rtc.destroy();
});

test('_localStatsPc retry symmetry: single caller retries up to MAX_BUILD_ATTEMPTS', async () => {
  // Regression guard for the asymmetry: previously the original builder got
  // exactly one shot while concurrent waiters got retried. A solo caller
  // hitting a transient native failure must also retry until the cap.
  // _buildLocalStatsPc catches sync throws and reports non-fatal, leaving
  // _localStatsPc null — so _ensureLocalStatsPc must self-recurse.
  RTCPeerConnection.mockImplementation(() => { throw new Error('native broken'); });
  const signaling = makeSignaling();
  const rtc = new WebRTCManager(signaling, jest.fn(), jest.fn(), jest.fn(), jest.fn());
  rtc.localStream = { getTracks: () => [] };

  // ONE call should now exhaust all 3 attempts (was 1 attempt before).
  await rtc._ensureLocalStatsPc();
  expect(RTCPeerConnection).toHaveBeenCalledTimes(3);
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
