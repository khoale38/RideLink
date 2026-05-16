/**
 * Manages WebRTC peer connections for group voice chat.
 * One PeerConnection per remote rider.
 * Uses local-only ICE (no STUN/TURN) since all peers are on the same hotspot LAN.
 */
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
} from 'react-native-webrtc';
import { logger } from './logger';

const RTC_CONFIG = {
  iceServers: [], // No STUN/TURN — all local LAN
  iceTransportPolicy: 'all',
};

// Offer watchdog deadline. Must exceed the signaling client's CONNECT_TIMEOUT_MS
// (10s) plus a generous answer round-trip — otherwise a signaling reconnect
// underneath an in-flight negotiation can churn pcs back-to-back as the
// watchdog tears them down faster than the new socket can carry the answer.
const OFFER_WATCHDOG_MS = 20000;

export class WebRTCManager {
  constructor(signalingClient, onVoiceActivity, onError, onPeerState, onLocalVoiceActivity, onLocalAudioLevel) {
    this.signaling = signalingClient;
    this.onVoiceActivity = onVoiceActivity;
    this.onLocalVoiceActivity = onLocalVoiceActivity; // (speaking) — true when our mic is hot
    // (level) — raw local audioLevel 0..1 from getStats media-source, fires
    // every poll. Used by useVOX on iOS where opening a parallel mic capture
    // would conflict with WebRTC's AVAudioSession.
    this.onLocalAudioLevel = onLocalAudioLevel;
    this.onError = onError;
    this.onPeerState = onPeerState; // (peerId, state) — 'connecting' | 'connected' | 'failed'
    this.peers = new Map(); // peerId -> RTCPeerConnection
    this.initiatorOf = new Set(); // peer ids where WE created the original offer
    this.disconnectTimers = new Map(); // peerId -> Timeout for ICE-restart grace
    // peerId -> Timeout that fires if our local offer never gets an answer.
    // Guards the impolite-glare deadlock where we ignored the polite peer's
    // offer and their answer to ours never arrived (they tore down their pc),
    // leaving signalingState stuck in 'have-local-offer' indefinitely.
    this.offerWatchdogs = new Map();
    this.localStream = null;
    this.destroyed = false;
    this.myId = null; // set by setMyId() — used for polite-peer tie-break on glare

    this.speakingState = new Map(); // peerId -> bool (last reported)
    this.localSpeaking = false;
    this.speakingPoll = null;
    // Offers that arrived before setMyId() — replayed once we know our id so
    // the glare tie-break in _handleOffer is symmetric on both peers.
    this.pendingOffers = [];
    // peerId -> [candidate, ...]. ICE candidates that arrived before the
    // pc had a remote description applied (the gap between
    // _createPeerConnection and setRemoteDescription, especially on the
    // polite-glare path where we tear down and rebuild). Without buffering,
    // these throw InvalidStateError on addIceCandidate and the trickle is
    // lost, delaying connect by seconds on slow links.
    this.pendingCandidates = new Map();

    this._bindSignalingHandlers();
    this._startSpeakingPoll();
  }

  // Poll inbound-rtp audio stats every ~300ms to detect when a remote rider is
  // actually talking. Replaces the old ontrack-once-and-stay-green behavior.
  _startSpeakingPoll() {
    if (this.speakingPoll) return;
    // Adaptive cadence: 300ms is responsive enough for "who's talking" UI, but
    // with many peers each tick fans out to N getStats() calls. Slow down past
    // 4 peers to keep CPU/battery in check on large group rides.
    const fastMs = 300;
    const slowMs = 600;
    const SPEAKING_THRESHOLD = 0.01; // audioLevel is 0..1 — anything noisy
    let currentMs = fastMs;
    const schedule = (ms) => {
      currentMs = ms;
      this.speakingPoll = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (this.destroyed) return;
      let localLevel = 0;
      // Always read our own mic level from the local-only stats pc — that way
      // a solo host (peers.size === 0) still sees a non-zero audioLevel and
      // VOX calibration can complete instead of waiting 8s for the fallback.
      if (this._localStatsPc) {
        try {
          const stats = await this._localStatsPc.getStats();
          if (this.destroyed) return;
          stats.forEach((report) => {
            if (report.type === 'media-source' && typeof report.audioLevel === 'number') {
              if (report.audioLevel > localLevel) localLevel = report.audioLevel;
            }
          });
        } catch (_) { /* getStats can throw mid-teardown; ignore */ }
      }
      for (const [peerId, pc] of this.peers) {
        try {
          const stats = await pc.getStats();
          if (this.destroyed) return;
          let remoteLevel = 0;
          stats.forEach((report) => {
            const isAudio = report.kind === 'audio' || report.mediaType === 'audio';
            if (!isAudio) return;
            if (report.type === 'inbound-rtp' && typeof report.audioLevel === 'number') {
              if (report.audioLevel > remoteLevel) remoteLevel = report.audioLevel;
            } else if (report.type === 'media-source' && typeof report.audioLevel === 'number') {
              // Our own mic input — same value across every pc, so taking the
              // max across the loop is harmless and a noop after the first one.
              if (report.audioLevel > localLevel) localLevel = report.audioLevel;
            }
          });
          const speaking = remoteLevel >= SPEAKING_THRESHOLD;
          if (this.speakingState.get(peerId) !== speaking) {
            this.speakingState.set(peerId, speaking);
            this.onVoiceActivity?.(peerId, speaking);
          }
        } catch (_) { /* getStats can throw mid-teardown; ignore */ }
      }
      const localSpeaking = localLevel >= SPEAKING_THRESHOLD;
      if (this.localSpeaking !== localSpeaking) {
        this.localSpeaking = localSpeaking;
        this.onLocalVoiceActivity?.(localSpeaking);
      }
      this.onLocalAudioLevel?.(localLevel);
      if (this.destroyed) return;
      const nextMs = this.peers.size > 4 ? slowMs : fastMs;
      if (nextMs !== currentMs) {
        logger.warn('WebRTC', `speaking poll cadence → ${nextMs}ms`, { peers: this.peers.size });
      }
      schedule(nextMs);
    };
    schedule(currentMs);
  }

  _stopSpeakingPoll() {
    if (this.speakingPoll) {
      clearTimeout(this.speakingPoll);
      this.speakingPoll = null;
    }
    this.speakingState.clear();
  }

  // Called by useIntercom after the signaling server replies with our id.
  // Required for offer-glare resolution; until it's set we behave as impolite.
  //
  // Ordering contract: peer_list handler MUST call setMyId BEFORE iterating
  // peers to call callPeer(). Otherwise the new pcs would be created without
  // a glare tie-break id, and any incoming offer racing in would queue into
  // pendingOffers and never replay (because callPeer's offer is already on
  // the wire). resetPeers() nulls myId so a reconnect re-establishes this
  // ordering naturally.
  setMyId(id) {
    this.myId = id;
    if (this.pendingOffers.length) {
      const queued = this.pendingOffers;
      this.pendingOffers = [];
      queued.forEach((msg) => { this._handleOffer(msg); });
    }
  }

  async startLocalAudio() {
    try {
      this.localStream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      await this._ensureLocalStatsPc();
      return this.localStream;
    } catch (err) {
      this._reportError('getUserMedia', err);
      throw err;
    }
  }

  // Stand up a loopback PeerConnection pair that owns the local stream. The
  // two PCs handshake against each other in-process so `media-source`
  // audioLevel reports are reliably populated by getStats() — react-native-
  // webrtc on iOS doesn't fill them when only setLocalDescription is called
  // without a matching remote answer. This is the same trick the mic test
  // uses and is what lets a solo host's "speaking" indicator light up.
  //
  // RETIREMENT: this workaround targets a specific react-native-webrtc bug.
  // When that dep is bumped, re-test solo-host VOX with this whole loopback
  // pair removed — if `media-source` audioLevel is now populated from a
  // single pc with only setLocalDescription, delete _ensureLocalStatsPc /
  // _buildLocalStatsPc / _localStatsPc* entirely and just call getStats()
  // on a peer pc (or a single dummy pc) directly.
  async _ensureLocalStatsPc() {
    if (this._localStatsPc || !this.localStream || this.destroyed) return;
    // In-flight guard: concurrent startLocalAudio calls (e.g. reconnect race)
    // would otherwise each build a loopback pc pair; the first assignment
    // would be orphaned with no close() ever called. Share the promise so
    // every caller awaits the same single setup.
    if (this._localStatsPcSetup) {
      await this._localStatsPcSetup;
      // If the in-flight build failed, _localStatsPc stays null. Let the
      // next caller retry instead of silently returning a half-init state.
      if (!this._localStatsPc && !this.destroyed) return this._ensureLocalStatsPc();
      return;
    }
    this._localStatsPcSetup = this._buildLocalStatsPc();
    try {
      await this._localStatsPcSetup;
    } finally {
      this._localStatsPcSetup = null;
    }
  }

  async _buildLocalStatsPc() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const pcRemote = new RTCPeerConnection(RTC_CONFIG);
    try {
      // Surface loopback ICE errors as non-fatal so a broken handshake doesn't
      // silently leave _localStatsPc unset (solo-host speaking indicator dead).
      pc.addEventListener?.('icecandidate', (e) => {
        if (e.candidate) {
          try {
            const p = pcRemote.addIceCandidate(e.candidate);
            if (p && typeof p.catch === 'function') {
              p.catch((err) => this._reportError('localStatsPc.addIce(remote)', err, null, /* fatal */ false));
            }
          } catch (err) {
            this._reportError('localStatsPc.addIce(remote)', err, null, /* fatal */ false);
          }
        }
      });
      pcRemote.addEventListener?.('icecandidate', (e) => {
        if (e.candidate) {
          try {
            const p = pc.addIceCandidate(e.candidate);
            if (p && typeof p.catch === 'function') {
              p.catch((err) => this._reportError('localStatsPc.addIce(local)', err, null, /* fatal */ false));
            }
          } catch (err) {
            this._reportError('localStatsPc.addIce(local)', err, null, /* fatal */ false);
          }
        }
      });
      // Critical: the loopback handshake makes pcRemote auto-play the received
      // audio through the device speaker (same path the mic test uses on
      // purpose). Without silencing it, the rider would hear themselves and
      // the playback would feed back into the mic. Setting `enabled = false`
      // is the spec-compliant way to suppress playback while keeping the
      // sender's stats path alive.
      pcRemote.addEventListener?.('track', (e) => {
        const track = e?.track;
        if (track) {
          try { track.enabled = false; } catch (_) { /* ignore */ }
        }
      });
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      const offer = await pc.createOffer();
      if (this.destroyed) { try { pc.close(); } catch (_) {} try { pcRemote.close(); } catch (_) {} return; }
      await pc.setLocalDescription(offer);
      await pcRemote.setRemoteDescription(offer);
      // Disable any received tracks BEFORE the answer is set — on some
      // react-native-webrtc builds the platform starts routing decoded audio
      // to the device speaker as soon as setLocalDescription(answer) runs,
      // which is earlier than the 'track' event in step below. Doing it here
      // closes the few-ms loopback window.
      try {
        pcRemote.getReceivers?.().forEach((r) => {
          if (r?.track) { try { r.track.enabled = false; } catch (_) { /* ignore */ } }
        });
      } catch (_) { /* ignore */ }
      const answer = await pcRemote.createAnswer();
      await pcRemote.setLocalDescription(answer);
      await pc.setRemoteDescription(answer);
      this._localStatsPc = pc;
      this._localStatsPcRemote = pcRemote;
    } catch (err) {
      try { pc.close(); } catch (_) { /* ignore */ }
      try { pcRemote.close(); } catch (_) { /* ignore */ }
      this._reportError('localStatsPc', err, null, /* fatal */ false);
    }
  }

  async callPeer(peerId) {
    if (this.destroyed) return;
    // Skip if we already have a connection in progress / established — prevents
    // duplicate offers on signaling reconnect when peer_list is replayed.
    if (this.peers.has(peerId)) return;

    const pc = this._createPeerConnection(peerId);
    if (!pc) return;
    this.initiatorOf.add(peerId);
    try {
      this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      const offer = await pc.createOffer();
      if (this.destroyed) return;
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
      this._armOfferWatchdog(peerId);
    } catch (err) {
      this._reportError('callPeer', err, peerId);
      this._removePeer(peerId);
    }
  }

  // If our local offer is still unanswered after a generous window, force a
  // recovery: tear down the pc and let the peer (re-)initiate via peer_list
  // replay on next reconnect, or via the larger-id ICE-restart election.
  // Without this, the impolite-glare path can leave us stuck in
  // 'have-local-offer' forever and the rider hears nothing.
  _armOfferWatchdog(peerId) {
    this._clearOfferWatchdog(peerId);
    const t = setTimeout(() => {
      this.offerWatchdogs.delete(peerId);
      const pc = this.peers.get(peerId);
      if (!pc || this.destroyed) return;
      if (pc.signalingState !== 'have-local-offer') return; // answered or rolled back
      if (__DEV__) console.warn('[WebRTC] offer watchdog: tearing down stuck pc for', peerId);
      this._reportError('offerWatchdog', new Error('offer unanswered, tearing down'), peerId, /* fatal */ false);
      this._removePeer(peerId);
    }, OFFER_WATCHDOG_MS);
    this.offerWatchdogs.set(peerId, t);
  }

  _clearOfferWatchdog(peerId) {
    const t = this.offerWatchdogs.get(peerId);
    if (t) {
      clearTimeout(t);
      this.offerWatchdogs.delete(peerId);
    }
  }

  // ICE restart — deterministically elected by id comparison so exactly one
  // side drives the restart regardless of who originally initiated. The
  // larger id (impolite side, matches glare tie-break) sends the new offer.
  // This avoids relying on `initiatorOf`, which is cleared on the polite
  // side after glare resolution and would otherwise leave a peer with no
  // one willing to restart it.
  async _restartIce(peerId) {
    const pc = this.peers.get(peerId);
    if (!pc || this.destroyed) return;
    if (!this.myId || this.myId < peerId) return;
    try {
      if (__DEV__) console.warn('[WebRTC] restarting ICE for', peerId);
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.destroyed) return;
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
      this._armOfferWatchdog(peerId);
      this.onPeerState?.(peerId, 'connecting');
    } catch (err) {
      this._reportError('restartIce', err, peerId, /* fatal */ false);
    }
  }

  async _handleOffer(msg) {
    if (this.destroyed) return;

    // Glare tie-break needs our own id. If an offer arrives before peer_list
    // has set it (rare race on first join), buffer until setMyId() replays.
    if (!this.myId) {
      // Dedupe by `from`: only the latest offer per peer matters (a re-offer
      // supersedes any earlier one from the same peer). This bounds the
      // queue to N peers without FIFO-dropping legitimate offers from
      // different peers during large-group reconnect storms.
      const existingIdx = this.pendingOffers.findIndex((m) => m.from === msg.from);
      if (existingIdx !== -1) {
        this.pendingOffers[existingIdx] = msg;
      } else {
        this.pendingOffers.push(msg);
      }
      return;
    }

    // Offer glare / mid-renegotiation: if we already have a pc with this peer
    // that is NOT in 'stable', applying setRemoteDescription will throw
    // InvalidStateError. Perfect-negotiation tie-break — the lexicographically
    // smaller id is "polite" and yields; the impolite side drops the offer.
    // We treat any non-stable signalingState the same way: 'have-local-offer'
    // is classic glare, but 'have-remote-offer' / 'have-local-pranswer' /
    // 'have-remote-pranswer' (ICE-restart races) need the same handling.
    const existing = this.peers.get(msg.from);
    if (existing && existing.signalingState && existing.signalingState !== 'stable') {
      const polite = this.myId < msg.from;
      if (!polite) {
        if (__DEV__) console.warn('[WebRTC] glare: ignoring offer from', msg.from, 'in', existing.signalingState);
        // Re-arm the offer watchdog: glare means the polite peer will tear
        // down their pc and send us an answer to our ORIGINAL local offer.
        // On slow links that round trip can exceed the initial 15s window —
        // without this refresh, the watchdog would nuke a healthy in-flight
        // pc just as the polite peer's answer is on the wire.
        if (existing.signalingState === 'have-local-offer') {
          this._armOfferWatchdog(msg.from);
        }
        return;
      }
      // Polite side: tear down the in-flight local pc and accept the remote
      // offer on a fresh one. _createPeerConnection short-circuits when the
      // peer is already present, so the removal must happen first.
      // No new offer watchdog needed on the rebuilt pc — we'll be the
      // answerer here, so signalingState moves stable→have-remote-offer→
      // stable without ever sitting in have-local-offer. The watchdog only
      // guards the unanswered-local-offer deadlock.
      //
      // Preserve any ICE candidates buffered for THIS peer across the
      // rebuild: trickle from the remote can race ahead of their offer's
      // SDP arrival, and _removePeer would otherwise wipe them right before
      // we stand up the new pc. Candidates with stale ufrag from a prior
      // session will be rejected by the WebRTC stack on flush (logged
      // non-fatally), so the worst case is a few harmless warnings.
      const preservedCandidates = this.pendingCandidates.get(msg.from);
      this._removePeer(msg.from);
      if (preservedCandidates && preservedCandidates.length) {
        this.pendingCandidates.set(msg.from, preservedCandidates);
      }
    }

    const pc = this._createPeerConnection(msg.from);
    if (!pc) return;
    try {
      this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      await this._flushPendingCandidates(msg.from);
      const answer = await pc.createAnswer();
      if (this.destroyed) return;
      await pc.setLocalDescription(answer);
      this.signaling.send({ type: 'answer', to: msg.from, sdp: answer });
    } catch (err) {
      this._reportError('handleOffer', err, msg.from);
      this._removePeer(msg.from);
    }
  }

  async _handleAnswer(msg) {
    const pc = this.peers.get(msg.from);
    if (!pc) return;
    // A late/stray answer (e.g. arriving after glare resolution swapped our
    // local offer out, or after an ICE restart already produced a new offer)
    // would otherwise throw InvalidStateError on setRemoteDescription and
    // tear down a healthy pc. Only apply when we actually have a pending
    // local offer; otherwise log non-fatally and keep the connection.
    if (pc.signalingState !== 'have-local-offer') {
      this._reportError('handleAnswer.staleState', new Error(`unexpected signalingState=${pc.signalingState}`), msg.from, /* fatal */ false);
      // If negotiation already settled via another path (stable), the watchdog
      // is no longer guarding anything — leaving it armed would later tear
      // down a healthy pc when the deadline fires. Clear it here so the
      // "stale answer arrived after we already converged" case is benign.
      if (pc.signalingState === 'stable') this._clearOfferWatchdog(msg.from);
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      this._clearOfferWatchdog(msg.from);
      await this._flushPendingCandidates(msg.from);
    } catch (err) {
      this._reportError('handleAnswer', err, msg.from);
      this._removePeer(msg.from);
    }
  }

  async _handleIceCandidate(msg) {
    const pc = this.peers.get(msg.from);
    if (!pc || !msg.candidate) return;
    // If the pc has no remote description yet (e.g. the polite-glare path
    // just rebuilt it and setRemoteDescription is still in flight), buffer
    // the candidate so the trickle isn't lost. _flushPendingCandidates drains
    // the queue once SDP is applied.
    if (!pc.remoteDescription) {
      const queue = this.pendingCandidates.get(msg.from) ?? [];
      // Bound the queue — a misbehaving peer shouldn't pin memory.
      // The queue can also straddle SDP epochs across a polite-glare rebuild
      // (we deliberately preserve it in _handleOffer so trickle isn't lost).
      // Stale-epoch candidates have a mismatched ufrag and will be rejected
      // by addIceCandidate at flush time — _flushPendingCandidates routes
      // those errors through _reportError with fatal=false, so the worst case
      // is a few benign warnings, not a torn-down connection.
      const MAX_PENDING_CANDIDATES = 64;
      if (queue.length >= MAX_PENDING_CANDIDATES) queue.shift();
      queue.push(msg.candidate);
      this.pendingCandidates.set(msg.from, queue);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      // ICE candidate errors are common and recoverable (e.g. arrived before remote SDP).
      // Log but don't tear down the connection.
      this._reportError('addIceCandidate', err, msg.from, /* fatal */ false);
    }
  }

  async _flushPendingCandidates(peerId) {
    const queue = this.pendingCandidates.get(peerId);
    if (!queue || queue.length === 0) return;
    this.pendingCandidates.delete(peerId);
    const pc = this.peers.get(peerId);
    if (!pc) return;
    for (const cand of queue) {
      if (this.destroyed) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        this._reportError('flushIceCandidate', err, peerId, /* fatal */ false);
      }
    }
  }

  _createPeerConnection(peerId) {
    if (this.destroyed) return null;
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = ({ candidate }) => {
      // Identity check: a torn-down pc can still emit a trailing candidate
      // (the native side flushes its gatherer). Sending it to a peer we've
      // already removed (or worse, a rebuilt pc replaced this one in the
      // map) wastes bandwidth and confuses the remote. Drop unless the map
      // still points at THIS pc instance.
      if (!candidate) return;
      if (this.peers.get(peerId) !== pc) return;
      this.signaling.send({ type: 'ice_candidate', to: peerId, candidate });
    };

    pc.ontrack = (_event) => {
      // react-native-webrtc auto-plays remote audio tracks. Speaking state is
      // driven by getStats polling (_startSpeakingPoll), not by this event.
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connecting' || state === 'new') {
        this.onPeerState?.(peerId, 'connecting');
      } else if (state === 'connected') {
        this._clearDisconnectTimer(peerId);
        this.onPeerState?.(peerId, 'connected');
      } else if (state === 'disconnected') {
        // Often transient (brief radio drop). Give it 5s to recover on its own
        // before driving an explicit ICE restart from the initiator side.
        this.onPeerState?.(peerId, 'connecting');
        this._scheduleIceRestart(peerId, 5000);
      } else if (state === 'failed') {
        // Definitively broken — try ICE restart immediately. Keep the pc in the
        // map so we don't lose state; UI shows 'connecting' until it recovers.
        this.onPeerState?.(peerId, 'connecting');
        this._scheduleIceRestart(peerId, 0);
      } else if (state === 'closed') {
        this._clearDisconnectTimer(peerId);
        this.onPeerState?.(peerId, 'failed');
      }
    };

    this.peers.set(peerId, pc);
    this.onPeerState?.(peerId, 'connecting');
    return pc;
  }

  _removePeer(peerId) {
    this._clearDisconnectTimer(peerId);
    this._clearOfferWatchdog(peerId);
    this.pendingCandidates.delete(peerId);
    this.initiatorOf.delete(peerId);
    const pc = this.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) { /* already closed */ }
      this.peers.delete(peerId);
    }
  }

  _scheduleIceRestart(peerId, delayMs) {
    this._clearDisconnectTimer(peerId);
    const t = setTimeout(() => {
      this.disconnectTimers.delete(peerId);
      const pc = this.peers.get(peerId);
      if (!pc) return;
      // If the connection has already recovered, don't kick a restart.
      if (pc.connectionState === 'connected') return;
      this._restartIce(peerId);
    }, delayMs);
    this.disconnectTimers.set(peerId, t);
  }

  _clearDisconnectTimer(peerId) {
    const t = this.disconnectTimers.get(peerId);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(peerId);
    }
  }

  _reportError(stage, err, peerId, fatal = true) {
    // Extract the bits we actually need at the log sink — RN's console serializer
    // sometimes drops Error fields, so unpack name/message/stack explicitly. SDP
    // errors in particular tend to throw OperationError with the useful detail
    // only in `message`.
    const detail = {
      stage,
      peerId,
      name: err?.name ?? null,
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
    };
    if (fatal) {
      logger.error('WebRTC', err, detail);
      this.onError?.({ ...detail, error: err });
    } else {
      logger.warn('WebRTC', `${stage} non-fatal`, detail);
    }
  }

  // Public: useIntercom calls this from its own peer_left handler so we don't
  // clobber whatever else is registered on the signaling handlers object.
  handlePeerLeft(peerId) {
    this._removePeer(peerId);
  }

  // Drop every peer connection on a signaling reconnect. The server will issue
  // us a fresh clientId, so existing peers (which saw our old socket close)
  // already tore down their side and will see us as a new peer_joined.
  // Without this reset, callPeer() short-circuits on stale ids in this.peers
  // and the rejoiner becomes a silent guest.
  resetPeers() {
    if (this.destroyed) return;
    const ids = Array.from(this.peers.keys());
    ids.forEach((id) => this._removePeer(id));
    // Defensive: _removePeer already clears each peer's timer, but if a timer
    // was somehow orphaned (peer removed but timer key left behind by a prior
    // bug), flush the whole map so a stray restart can't fire post-reset.
    this.disconnectTimers.forEach((t) => clearTimeout(t));
    this.disconnectTimers.clear();
    this.offerWatchdogs.forEach((t) => clearTimeout(t));
    this.offerWatchdogs.clear();
    this.pendingCandidates.clear();
    this.initiatorOf.clear();
    this.pendingOffers = [];
    this.myId = null;
  }

  _bindSignalingHandlers() {
    const handlers = this.signaling.handlers;
    handlers.offer = (msg) => this._handleOffer(msg);
    handlers.answer = (msg) => this._handleAnswer(msg);
    handlers.ice_candidate = (msg) => this._handleIceCandidate(msg);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnectTimers.forEach((t) => clearTimeout(t));
    this.disconnectTimers.clear();
    this.offerWatchdogs.forEach((t) => clearTimeout(t));
    this.offerWatchdogs.clear();
    this.pendingCandidates.clear();
    this.initiatorOf.clear();
    this.pendingOffers = [];
    this._stopSpeakingPoll();
    this.peers.forEach((pc) => {
      try { pc.close(); } catch (_) { /* already closed */ }
    });
    this.peers.clear();
    if (this._localStatsPc) {
      try { this._localStatsPc.close(); } catch (_) { /* already closed */ }
      this._localStatsPc = null;
    }
    if (this._localStatsPcRemote) {
      try { this._localStatsPcRemote.close(); } catch (_) { /* already closed */ }
      this._localStatsPcRemote = null;
    }
    this.localStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) { /* ignore */ }
    });
    this.localStream = null;
  }
}
