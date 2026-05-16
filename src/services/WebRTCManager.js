/**
 * Manages WebRTC peer connections for group voice chat.
 * One PeerConnection per remote rider.
 * Uses local-only ICE (no STUN/TURN) since all peers are on the same hotspot LAN.
 *
 * State model: every peer has exactly one PeerEntry in `this.peers`. The entry
 * owns its pc, timers, watchdog, ICE-candidate buffer, and restart counter —
 * so teardown is a single map delete and identity checks reduce to
 * `_isFresh(id, entry)` rather than tracking pcs across multiple parallel maps.
 *
 * ----------------------------------------------------------------------------
 * Build-specific workarounds (do NOT delete without re-testing the listed
 * scenarios on the bumped react-native-webrtc version).
 * ----------------------------------------------------------------------------
 *
 * 1. `_localStatsPc` / `_buildLocalStatsPc` loopback PeerConnection pair.
 *    REASON: react-native-webrtc on iOS does not populate `media-source`
 *    audioLevel in getStats() unless the local SDP has a matching remote
 *    answer. Without a peer, a solo host's "speaking" indicator stays dark
 *    and VOX calibration never completes.
 *    REMEDY: handshake against an in-process companion pc so the stats path
 *    is hot. The companion's received track is muted twice (event-time AND
 *    via getReceivers pre-loop) because some builds start auto-playing
 *    decoded audio between setLocalDescription(answer) and the 'track'
 *    event firing, causing the rider to hear themselves.
 *    RETIREMENT CHECK: solo-host VOX lights up with a single pc and only
 *    setLocalDescription called.
 *
 * 2. `oniceconnectionstatechange` driving `onPeerState('connected')` and
 *    resetting `restartAttempts`.
 *    REASON: on some react-native-webrtc builds `connectionState` parks in
 *    'connecting' even when ICE has actually reached 'connected' and media
 *    is flowing. Without this, the UI badge stays yellow forever and the
 *    ICE-restart backoff keeps climbing despite each restart making partial
 *    progress.
 *    RETIREMENT CHECK: end-to-end connect cleanly advances connectionState
 *    to 'connected' on both iOS and Android within the watchdog window.
 *
 * 3. Sibling-handler composition in `_bindSignalingHandlers`.
 *    REASON: useIntercom installs handler functions on the shared
 *    `handlers` object BEFORE the WebRTCManager is constructed; clobbering
 *    them would silently break sibling listeners that the hook may add for
 *    metrics or UI side effects.
 *    RETIREMENT CHECK: not build-specific — this is a permanent
 *    architectural constraint of the shared-handlers shape.
 *
 * 4. `pendingCandidates` buffer with preserved-across-rebuild semantics.
 *    REASON: trickle ICE from a remote can race ahead of their SDP arrival
 *    on slow links. The polite-glare path tears down and rebuilds the pc,
 *    so naive deletion of the buffer would drop legitimate candidates.
 *    Stale-ufrag candidates that survive the rebuild are rejected
 *    non-fatally at flush time.
 *    RETIREMENT CHECK: not build-specific — inherent to perfect negotiation
 *    + trickle ICE.
 *
 * The PeerEntry constructor at line ~58 declares every per-peer field so a
 * `git grep PeerEntry` from a future maintainer surfaces the full state
 * surface without having to read every method that touches `entry.*`.
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

// ICE-restart backoff. 'failed' connectionState used to schedule a restart with
// delay 0 unconditionally — under a persistent network problem (host moved out
// of range, radio off) that looped forever, spamming offers and burning CPU.
const ICE_RESTART_BASE_MS = 500;
const ICE_RESTART_MAX_MS = 30000;
const ICE_RESTART_MAX_ATTEMPTS = 6;

// Bound the per-peer ICE buffer. Stale-epoch candidates after a polite-glare
// rebuild are rejected non-fatally at flush time, so the worst case here is a
// few benign warnings rather than a torn-down connection.
const MAX_PENDING_CANDIDATES = 64;

// Per-peer state. One instance per (peerId, pc) lifetime — replaced wholesale
// on glare-rebuild rather than mutated in place, so any in-flight operation
// that captured the old entry can bail by checking `entry.closed` or by
// comparing identity against `this.peers.get(id)`.
class PeerEntry {
  constructor(id, pc) {
    this.id = id;
    this.pc = pc;
    this.closed = false;
    this.initiator = false; // set true only AFTER we actually sent an offer
    this.disconnectTimer = null;
    this.offerWatchdog = null;
    this.pendingCandidates = [];
    this.speaking = false;
    this.restartAttempts = 0;
    this.candidateOverflowWarned = false;
    // Latched true on the first stale-state answer log per entry. Stale
    // answers are legitimate during fast ICE-restart churn, so we log once
    // and stay quiet — see _handleAnswer.
    this.staleAnswerLogged = false;
  }
}

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
    this.peers = new Map(); // peerId -> PeerEntry
    this.localStream = null;
    this.destroyed = false;
    this.myId = null; // set by setMyId() — used for polite-peer tie-break on glare

    this.localSpeaking = false;
    this.speakingPoll = null;
    // Offers that arrived before setMyId() — replayed once we know our id so
    // the glare tie-break in _handleOffer is symmetric on both peers.
    this.pendingOffers = [];

    this._bindSignalingHandlers();
    this._startSpeakingPoll();
  }

  // True iff `entry` is still the current entry for `id`. Replaces the
  // copy-pasted `this.peers.get(id) !== pc` checks that used to live inline
  // after every await. Any operation that started against an old entry (e.g.
  // before a polite-glare rebuild) should bail by calling this between awaits.
  _isFresh(id, entry) {
    return !this.destroyed && !entry.closed && this.peers.get(id) === entry;
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
    // UI callbacks invoked from tick (onVoiceActivity / onLocalVoiceActivity
    // / onLocalAudioLevel) can throw if a downstream setter blows up (e.g.
    // store mutation during teardown). Without this guard, a throw would
    // skip the trailing schedule(nextMs) and the poll would silently die.
    const safeNotify = (fn, label, ...args) => {
      if (!fn) return;
      try { fn(...args); } catch (err) {
        logger.warn('WebRTC', `${label} handler threw`, { error: err?.message ?? String(err) });
      }
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
      for (const [peerId, entry] of this.peers) {
        try {
          const stats = await entry.pc.getStats();
          if (this.destroyed) return;
          if (entry.closed) continue;
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
          if (entry.speaking !== speaking) {
            entry.speaking = speaking;
            safeNotify(this.onVoiceActivity, 'onVoiceActivity', peerId, speaking);
          }
        } catch (_) { /* getStats can throw mid-teardown; ignore */ }
      }
      const localSpeaking = localLevel >= SPEAKING_THRESHOLD;
      if (this.localSpeaking !== localSpeaking) {
        this.localSpeaking = localSpeaking;
        safeNotify(this.onLocalVoiceActivity, 'onLocalVoiceActivity', localSpeaking);
      }
      if (this.destroyed) return;
      safeNotify(this.onLocalAudioLevel, 'onLocalAudioLevel', localLevel);
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
  // on a peer pc (or a single dummy pc) directly. Alternative simplification
  // if the upstream bug stays: replace the double track-disable hack with a
  // `pcRemote.addTransceiver('audio', { direction: 'recvonly' })` combined
  // with discarding pcRemote's receivers — eliminates the playback path
  // entirely instead of suppressing it after the fact.
  async _ensureLocalStatsPc() {
    // Bound retries — a synchronously throwing RTCPeerConnection constructor
    // (broken native module, unsupported platform) would otherwise loop
    // forever as every caller re-tries the build path below. Iterative loop
    // keeps the retry budget visible in one place; previously the same
    // condition lived in two recursive tails (concurrent waiter + post-build)
    // which made the worst-case call depth harder to reason about.
    const MAX_BUILD_ATTEMPTS = 3;
    while (!this._localStatsPc && this.localStream && !this.destroyed) {
      if ((this._localStatsPcAttempts ?? 0) >= MAX_BUILD_ATTEMPTS) return;
      // In-flight guard: concurrent startLocalAudio calls (e.g. reconnect
      // race) would otherwise each build a loopback pc pair; the first
      // assignment would be orphaned with no close() ever called. Share the
      // promise so every caller awaits the same single setup.
      if (this._localStatsPcSetup) {
        await this._localStatsPcSetup;
        // If the in-flight build failed, _localStatsPc stays null and the
        // loop condition retries (up to MAX_BUILD_ATTEMPTS).
        continue;
      }
      this._localStatsPcAttempts = (this._localStatsPcAttempts ?? 0) + 1;
      this._localStatsPcSetup = this._buildLocalStatsPc();
      try {
        await this._localStatsPcSetup;
      } finally {
        this._localStatsPcSetup = null;
      }
    }
  }

  async _buildLocalStatsPc() {
    let pc;
    let pcRemote;
    try {
      // Construct inside the try so a synchronously-throwing native
      // RTCPeerConnection constructor (broken native module, unsupported
      // platform) routes through _reportError as non-fatal instead of
      // escaping awaiters of _ensureLocalStatsPc.
      pc = new RTCPeerConnection(RTC_CONFIG);
      pcRemote = new RTCPeerConnection(RTC_CONFIG);
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
      try { pc?.close(); } catch (_) { /* ignore */ }
      try { pcRemote?.close(); } catch (_) { /* ignore */ }
      this._reportError('localStatsPc', err, null, /* fatal */ false);
    }
  }

  async callPeer(peerId) {
    if (this.destroyed) return;
    // Skip if we already have a connection in progress / established — prevents
    // duplicate offers on signaling reconnect when peer_list is replayed.
    if (this.peers.has(peerId)) return;

    const entry = this._createPeerConnection(peerId);
    if (!entry) return;
    try {
      this.localStream?.getTracks().forEach((t) => entry.pc.addTrack(t, this.localStream));
      const offer = await entry.pc.createOffer();
      if (!this._isFresh(peerId, entry)) return;
      await entry.pc.setLocalDescription(offer);
      // Identity check: between the awaits above, _removePeer (teardown,
      // peer_left, glare rebuild) may have replaced or dropped this entry.
      // Don't send a stale offer or arm a watchdog against an entry no longer
      // in the map — mirrors the guard in onicecandidate.
      if (!this._isFresh(peerId, entry)) return;
      this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
      // Only mark as initiator AFTER we actually sent the offer. Setting it
      // up-front (the prior bug) left `initiator` dangling on entries that
      // bailed at the identity guard — harmless today, but a footgun.
      entry.initiator = true;
      this._armOfferWatchdog(entry);
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
  // Generic negotiation watchdog. Fires if the pc is still mid-handshake
  // (any non-stable, non-closed signalingState) past the deadline. Originally
  // only guarded the caller side ('have-local-offer'); broadened to also
  // catch the answerer side ('have-remote-offer' from a partial/stalled
  // remote SDP) so neither role can wedge indefinitely.
  _armOfferWatchdog(entry) {
    this._clearOfferWatchdog(entry);
    const peerId = entry.id;
    entry.offerWatchdog = setTimeout(() => {
      entry.offerWatchdog = null;
      if (!this._isFresh(peerId, entry)) return;
      const s = entry.pc.signalingState;
      if (s === 'stable' || s === 'closed') return; // handshake completed
      if (__DEV__) console.warn('[WebRTC] negotiation watchdog: tearing down stuck pc for', peerId, 'in', s);
      this._reportError('offerWatchdog', new Error(`negotiation stalled in ${s}, tearing down`), peerId, /* fatal */ false);
      this._removePeer(peerId);
    }, OFFER_WATCHDOG_MS);
  }

  _clearOfferWatchdog(entry) {
    if (entry.offerWatchdog) {
      clearTimeout(entry.offerWatchdog);
      entry.offerWatchdog = null;
    }
  }

  // ICE restart — deterministically elected by id comparison so exactly one
  // side drives the restart regardless of who originally initiated. The
  // larger id (impolite side, matches glare tie-break) sends the new offer.
  // This avoids relying on `initiator`, which is cleared on the polite side
  // after glare resolution and would otherwise leave a peer with no one
  // willing to restart it.
  async _restartIce(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry || this.destroyed) return;
    if (!this.myId || this.myId < peerId) return;
    if (entry.restartAttempts >= ICE_RESTART_MAX_ATTEMPTS) {
      // Persistent failure — stop spinning. Tear down so peer_left / a future
      // peer_list replay can re-elect a fresh negotiation if the link
      // recovers. Without this cap, repeated 'failed' states would re-fire
      // _restartIce indefinitely, spamming offers and burning CPU.
      this._reportError('restartIce.giveUp',
        new Error(`ICE restart gave up after ${entry.restartAttempts} attempts`),
        peerId, /* fatal */ false);
      this._removePeer(peerId);
      return;
    }
    entry.restartAttempts += 1;
    try {
      if (__DEV__) console.warn('[WebRTC] restarting ICE for', peerId, `(attempt ${entry.restartAttempts})`);
      const offer = await entry.pc.createOffer({ iceRestart: true });
      if (!this._isFresh(peerId, entry)) return;
      await entry.pc.setLocalDescription(offer);
      // Same identity guard as callPeer: a teardown or glare-rebuild during
      // the awaits could have replaced this entry; don't push a stale offer.
      if (!this._isFresh(peerId, entry)) return;
      this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
      this._armOfferWatchdog(entry);
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

    // Buffered ICE candidates that need to survive a polite-glare rebuild.
    // Declared at function scope so the post-rebuild block can re-seed the
    // new entry without smuggling state through the msg argument.
    let preserved = null;

    // Offer glare / mid-renegotiation: if we already have a pc with this peer
    // that is NOT in 'stable', applying setRemoteDescription will throw
    // InvalidStateError. Perfect-negotiation tie-break — the lexicographically
    // smaller id is "polite" and yields; the impolite side drops the offer.
    // We treat any non-stable signalingState the same way: 'have-local-offer'
    // is classic glare, but 'have-remote-offer' / 'have-local-pranswer' /
    // 'have-remote-pranswer' (ICE-restart races) need the same handling.
    const existing = this.peers.get(msg.from);
    if (existing && existing.pc.signalingState && existing.pc.signalingState !== 'stable') {
      const polite = this.myId < msg.from;
      if (!polite) {
        if (__DEV__) console.warn('[WebRTC] glare: ignoring offer from', msg.from, 'in', existing.pc.signalingState);
        // Re-arm the offer watchdog: glare means the polite peer will tear
        // down their pc and send us an answer to our ORIGINAL local offer.
        // On slow links that round trip can exceed the initial 15s window —
        // without this refresh, the watchdog would nuke a healthy in-flight
        // pc just as the polite peer's answer is on the wire.
        if (existing.pc.signalingState === 'have-local-offer') {
          this._armOfferWatchdog(existing);
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
      preserved = existing.pendingCandidates;
      this._removePeer(msg.from);
    }

    const entry = this._createPeerConnection(msg.from);
    if (!entry) return;
    if (preserved && preserved.length) entry.pendingCandidates = preserved;
    // Arm the negotiation watchdog before any awaits — covers the answerer
    // side, so a stall in setRemoteDescription/createAnswer/setLocalDescription
    // can't leave the pc parked in 'have-remote-offer' forever.
    this._armOfferWatchdog(entry);
    try {
      this.localStream?.getTracks().forEach((t) => entry.pc.addTrack(t, this.localStream));
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      // Identity guard: a glare-rebuild or _removePeer during the awaits may
      // have swapped or evicted this entry. Mirrors the guards in callPeer /
      // _restartIce so we never push an answer for an orphaned pc.
      if (!this._isFresh(msg.from, entry)) return;
      await this._flushPendingCandidates(entry);
      if (!this._isFresh(msg.from, entry)) return;
      const answer = await entry.pc.createAnswer();
      if (!this._isFresh(msg.from, entry)) return;
      await entry.pc.setLocalDescription(answer);
      if (!this._isFresh(msg.from, entry)) return;
      this.signaling.send({ type: 'answer', to: msg.from, sdp: answer });
      this._clearOfferWatchdog(entry); // handshake done from our side
    } catch (err) {
      this._reportError('handleOffer', err, msg.from);
      this._removePeer(msg.from);
    }
  }

  async _handleAnswer(msg) {
    if (this.destroyed) return;
    const entry = this.peers.get(msg.from);
    if (!entry) return;
    // A late/stray answer (e.g. arriving after glare resolution swapped our
    // local offer out, or after an ICE restart already produced a new offer)
    // would otherwise throw InvalidStateError on setRemoteDescription and
    // tear down a healthy pc. Only apply when we actually have a pending
    // local offer; otherwise log non-fatally and keep the connection.
    if (entry.pc.signalingState !== 'have-local-offer') {
      // Stale answers are legitimate during fast ICE-restart round trips
      // (peer A sends new offer, peer B's old answer to A's prior offer
      // races in afterward). Logging once per entry per session is enough
      // to surface a genuine problem without spamming the journal under
      // healthy churn. Was warn-every-time which produced N log lines per
      // ICE restart and made real issues hard to spot.
      if (!entry.staleAnswerLogged && __DEV__) {
        entry.staleAnswerLogged = true;
        console.warn('[WebRTC] handleAnswer ignored (stale state)', msg.from, entry.pc.signalingState);
      }
      // The watchdog only guards the unanswered-local-offer deadlock. If
      // signalingState is anything else, it's no longer load-bearing —
      // leaving it armed would later tear down a healthy pc when the
      // deadline fires. Clear unconditionally; the previous "only when
      // stable" check missed have-remote-offer and have-*-pranswer.
      this._clearOfferWatchdog(entry);
      return;
    }
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      this._clearOfferWatchdog(entry);
      if (!this._isFresh(msg.from, entry)) return;
      await this._flushPendingCandidates(entry);
    } catch (err) {
      this._reportError('handleAnswer', err, msg.from);
      this._removePeer(msg.from);
    }
  }

  async _handleIceCandidate(msg) {
    if (this.destroyed) return;
    const entry = this.peers.get(msg.from);
    if (!entry || !msg.candidate) return;
    // If the pc has no remote description yet (e.g. the polite-glare path
    // just rebuilt it and setRemoteDescription is still in flight), buffer
    // the candidate so the trickle isn't lost. _flushPendingCandidates drains
    // the queue once SDP is applied.
    if (!entry.pc.remoteDescription) {
      const queue = entry.pendingCandidates;
      // Bound the queue — a misbehaving peer shouldn't pin memory.
      // The queue can also straddle SDP epochs across a polite-glare rebuild
      // (we deliberately preserve it in _handleOffer so trickle isn't lost).
      // Stale-epoch candidates have a mismatched ufrag and will be rejected
      // by addIceCandidate at flush time — _flushPendingCandidates routes
      // those errors through _reportError with fatal=false, so the worst case
      // is a few benign warnings, not a torn-down connection.
      if (queue.length >= MAX_PENDING_CANDIDATES) {
        queue.shift();
        // Surface silent ICE degradation — chronic queue overflow indicates the
        // peer is producing candidates faster than we apply SDP, which on slow
        // polite-rebuild loops can drop genuinely useful pairs. Log once per
        // peer per session to avoid spamming.
        if (!entry.candidateOverflowWarned) {
          entry.candidateOverflowWarned = true;
          this._reportError('iceCandidateBufferOverflow',
            new Error(`pending-candidate queue overflowed (${MAX_PENDING_CANDIDATES})`),
            msg.from, /* fatal */ false);
        }
      }
      queue.push(msg.candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      // ICE candidate errors are common and recoverable (e.g. arrived before remote SDP).
      // Log but don't tear down the connection.
      this._reportError('addIceCandidate', err, msg.from, /* fatal */ false);
    }
  }

  async _flushPendingCandidates(entry) {
    const queue = entry.pendingCandidates;
    if (queue.length === 0) return;
    entry.pendingCandidates = [];
    for (const cand of queue) {
      if (!this._isFresh(entry.id, entry)) return;
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        this._reportError('flushIceCandidate', err, entry.id, /* fatal */ false);
      }
    }
  }

  _createPeerConnection(peerId) {
    if (this.destroyed) return null;
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = new PeerEntry(peerId, pc);

    pc.onicecandidate = ({ candidate }) => {
      // Identity check: a torn-down pc can still emit a trailing candidate
      // (the native side flushes its gatherer). Sending it to a peer we've
      // already removed (or worse, a rebuilt pc replaced this one in the
      // map) wastes bandwidth and confuses the remote. Drop unless the map
      // still points at THIS entry.
      if (!candidate) return;
      if (!this._isFresh(peerId, entry)) return;
      this.signaling.send({ type: 'ice_candidate', to: peerId, candidate });
    };

    pc.ontrack = (_event) => {
      // react-native-webrtc auto-plays remote audio tracks. Speaking state is
      // driven by getStats polling (_startSpeakingPoll), not by this event.
    };

    // Reset the ICE-restart backoff as soon as ICE itself is healthy. The
    // connectionState='connected' branch below also resets, but on some
    // builds connectionState lags or never advances past 'connecting' even
    // while iceConnectionState is 'connected' (and media flows). Without this,
    // a flapping link could keep climbing toward ICE_RESTART_MAX_ATTEMPTS
    // despite each restart actually making partial progress.
    pc.oniceconnectionstatechange = () => {
      if (entry.closed) return;
      const ice = pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') {
        entry.restartAttempts = 0;
        // Drive the UI badge from here too: if connectionState is genuinely
        // parked in 'connecting' on this react-native-webrtc build (the bug
        // this listener guards against), the connectionState branch will
        // never fire 'connected' and the badge stays yellow forever even
        // though media is flowing. Calling onPeerState here is idempotent
        // when both states do fire — the embedding store ignores no-op
        // transitions.
        this.onPeerState?.(peerId, 'connected');
        // Also a great moment to clear a stale _localStatsPc build-attempt
        // budget: if loopback PC setup was failing transiently and we've
        // since established a real peer, conditions for the next attempt
        // are now demonstrably better. Without this, three early failures
        // permanently disable solo-host VOX until app restart.
        this._localStatsPcAttempts = 0;
      }
    };

    pc.onconnectionstatechange = () => {
      if (entry.closed) return;
      const state = pc.connectionState;
      // Unified restart scheduler. 'disconnected' is usually transient
      // (brief radio drop) so the first hit waits a generous DISCONNECT_GRACE
      // window before kicking a restart; 'failed' is definitively broken so
      // we go straight to the backoff schedule. Both paths consult the SAME
      // restartAttempts counter so an oscillating disconnected↔failed link
      // can't reset the timer to the fixed 5s grace value and defeat the
      // exponential backoff on every flap.
      const DISCONNECT_GRACE_MS = 5000;
      if (state === 'connecting' || state === 'new') {
        this.onPeerState?.(peerId, 'connecting');
      } else if (state === 'connected') {
        this._clearDisconnectTimer(entry);
        entry.restartAttempts = 0; // healthy — reset backoff
        this._localStatsPcAttempts = 0; // see oniceconnectionstatechange
        this.onPeerState?.(peerId, 'connected');
      } else if (state === 'disconnected' || state === 'failed') {
        this.onPeerState?.(peerId, 'connecting');
        const backoff = Math.min(
          ICE_RESTART_BASE_MS * 2 ** entry.restartAttempts,
          ICE_RESTART_MAX_MS,
        );
        // First disconnect with no prior restart attempts: give the link a
        // grace period to recover on its own before forcing a restart.
        // Otherwise (failed, or repeated disconnects) honor the backoff.
        const delay = state === 'disconnected' && entry.restartAttempts === 0
          ? DISCONNECT_GRACE_MS
          : backoff;
        this._scheduleIceRestart(entry, delay);
      } else if (state === 'closed') {
        this._clearDisconnectTimer(entry);
        this.onPeerState?.(peerId, 'failed');
      }
    };

    this.peers.set(peerId, entry);
    this.onPeerState?.(peerId, 'connecting');
    return entry;
  }

  _removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.closed = true;
    this._clearDisconnectTimer(entry);
    this._clearOfferWatchdog(entry);
    this.peers.delete(peerId);
    try { entry.pc.close(); } catch (_) { /* already closed */ }
  }

  _scheduleIceRestart(entry, delayMs) {
    this._clearDisconnectTimer(entry);
    const peerId = entry.id;
    entry.disconnectTimer = setTimeout(() => {
      entry.disconnectTimer = null;
      if (!this._isFresh(peerId, entry)) return;
      // If the connection has already recovered, don't kick a restart.
      if (entry.pc.connectionState === 'connected') return;
      this._restartIce(peerId);
    }, delayMs);
  }

  _clearDisconnectTimer(entry) {
    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
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

  // Public alias for _removePeer. useIntercom's peer_left handler also clears
  // the store entry, so it can't compose with our internal handler via the
  // _bindSignalingHandlers wrapping (which only covers offer/answer/ice).
  // Keeping this as a public method (rather than letting callers reach into
  // _removePeer directly) preserves the internal/external boundary if we
  // ever add bookkeeping that should only run on remote-initiated departure.
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
    // Deliberately preserves localStream and _localStatsPc. On a signaling
    // reconnect the mic capture is still valid (same AVAudioSession, same
    // track) — callPeer() in the replayed peer_list adds those existing
    // tracks to each fresh pc. Nulling localStream here would force a
    // full mic re-acquisition on every reconnect, which on iOS triggers a
    // brief audio-route glitch and on Android can race against the
    // foreground service.
    const ids = Array.from(this.peers.keys());
    ids.forEach((id) => this._removePeer(id));
    this.pendingOffers = [];
    this.myId = null;
  }

  _bindSignalingHandlers() {
    // Compose with whatever the caller already registered for these message
    // types — previously we clobbered them, which silently broke any future
    // sibling handler the embedding hook might add. Run the prior handler
    // first so its observation-only side effects (logging, metrics) see the
    // raw message before the WebRTC state machine reacts to it.
    //
    // Caller-handler exceptions are logged (not silently swallowed) so a bug
    // in a sibling listener doesn't disappear under a try/catch — the
    // WebRTC state machine still runs either way.
    const handlers = this.signaling.handlers;
    const prevOffer = handlers.offer;
    const prevAnswer = handlers.answer;
    const prevIce = handlers.ice_candidate;
    const safeCall = (name, prev, msg) => {
      if (!prev) return;
      try { prev(msg); } catch (err) {
        logger.warn('WebRTC', `sibling ${name} handler threw`, { error: err?.message ?? String(err) });
      }
    };
    handlers.offer = (msg) => { safeCall('offer', prevOffer, msg); this._handleOffer(msg); };
    handlers.answer = (msg) => { safeCall('answer', prevAnswer, msg); this._handleAnswer(msg); };
    handlers.ice_candidate = (msg) => { safeCall('ice_candidate', prevIce, msg); this._handleIceCandidate(msg); };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopSpeakingPoll();
    this.peers.forEach((entry) => {
      entry.closed = true;
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      if (entry.offerWatchdog) clearTimeout(entry.offerWatchdog);
      try { entry.pc.close(); } catch (_) { /* already closed */ }
    });
    this.peers.clear();
    this.pendingOffers = [];
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
