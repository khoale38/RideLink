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
    this.localStream = null;
    this.destroyed = false;
    this.myId = null; // set by setMyId() — used for polite-peer tie-break on glare

    this.speakingState = new Map(); // peerId -> bool (last reported)
    this.localSpeaking = false;
    this.speakingPoll = null;
    // Offers that arrived before setMyId() — replayed once we know our id so
    // the glare tie-break in _handleOffer is symmetric on both peers.
    this.pendingOffers = [];

    this._bindSignalingHandlers();
    this._startSpeakingPoll();
  }

  // Poll inbound-rtp audio stats every ~300ms to detect when a remote rider is
  // actually talking. Replaces the old ontrack-once-and-stay-green behavior.
  _startSpeakingPoll() {
    if (this.speakingPoll) return;
    const POLL_MS = 300;
    const SPEAKING_THRESHOLD = 0.01; // audioLevel is 0..1 — anything noisy
    this.speakingPoll = setInterval(async () => {
      if (this.destroyed) return;
      let localLevel = 0;
      // Always read our own mic level from the local-only stats pc — that way
      // a solo host (peers.size === 0) still sees a non-zero audioLevel and
      // VOX calibration can complete instead of waiting 8s for the fallback.
      if (this._localStatsPc) {
        try {
          const stats = await this._localStatsPc.getStats();
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
    }, POLL_MS);
  }

  _stopSpeakingPoll() {
    if (this.speakingPoll) {
      clearInterval(this.speakingPoll);
      this.speakingPoll = null;
    }
    this.speakingState.clear();
  }

  // Called by useIntercom after the signaling server replies with our id.
  // Required for offer-glare resolution; until it's set we behave as impolite.
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

  // Stand up a dummy PeerConnection that owns the local stream but never
  // talks to anyone. getStats() on it returns `media-source` reports so the
  // speaking-poll can read local audioLevel even when no real peer exists
  // yet (the iOS VOX path depends on this — see useVOX.js).
  async _ensureLocalStatsPc() {
    if (this._localStatsPc || !this.localStream || this.destroyed) return;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    try {
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      // setLocalDescription is required for media-source stats to appear on
      // some platforms; the offer never leaves the device.
      const offer = await pc.createOffer();
      if (this.destroyed) { try { pc.close(); } catch (_) {} return; }
      await pc.setLocalDescription(offer);
      this._localStatsPc = pc;
    } catch (err) {
      try { pc.close(); } catch (_) { /* ignore */ }
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
    } catch (err) {
      this._reportError('callPeer', err, peerId);
      this._removePeer(peerId);
    }
  }

  // ICE restart — only the side that originally created the offer for this
  // peer drives the restart, to avoid both sides racing offers under glare.
  async _restartIce(peerId) {
    const pc = this.peers.get(peerId);
    if (!pc || this.destroyed) return;
    if (!this.initiatorOf.has(peerId)) return;
    try {
      if (__DEV__) console.warn('[WebRTC] restarting ICE for', peerId);
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.destroyed) return;
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
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
      this.pendingOffers.push(msg);
      return;
    }

    // Offer glare: we already have a peer connection mid-negotiation with this
    // peer. Perfect-negotiation tie-break — the lexicographically smaller id is
    // "polite" and yields; the impolite side ignores the incoming offer.
    const existing = this.peers.get(msg.from);
    if (existing && existing.signalingState === 'have-local-offer') {
      const polite = this.myId < msg.from;
      if (!polite) {
        if (__DEV__) console.warn('[WebRTC] glare: ignoring offer from', msg.from);
        return;
      }
      this._removePeer(msg.from);
    }

    const pc = this._createPeerConnection(msg.from);
    if (!pc) return;
    try {
      this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (err) {
      this._reportError('handleAnswer', err, msg.from);
      this._removePeer(msg.from);
    }
  }

  async _handleIceCandidate(msg) {
    const pc = this.peers.get(msg.from);
    if (!pc || !msg.candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      // ICE candidate errors are common and recoverable (e.g. arrived before remote SDP).
      // Log but don't tear down the connection.
      this._reportError('addIceCandidate', err, msg.from, /* fatal */ false);
    }
  }

  _createPeerConnection(peerId) {
    if (this.destroyed) return null;
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.send({ type: 'ice_candidate', to: peerId, candidate });
      }
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
    if (fatal) {
      logger.error('WebRTC', err, { stage, peerId });
      this.onError?.({ stage, peerId, error: err });
    } else {
      logger.warn('WebRTC', `${stage} non-fatal`, { peerId, message: err?.message ?? String(err) });
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
    this.destroyed = true;
    this.disconnectTimers.forEach((t) => clearTimeout(t));
    this.disconnectTimers.clear();
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
    this.localStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) { /* ignore */ }
    });
    this.localStream = null;
  }
}
