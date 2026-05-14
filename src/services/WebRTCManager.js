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

const RTC_CONFIG = {
  iceServers: [], // No STUN/TURN — all local LAN
  iceTransportPolicy: 'all',
};

export class WebRTCManager {
  constructor(signalingClient, onVoiceActivity, onError, onPeerState) {
    this.signaling = signalingClient;
    this.onVoiceActivity = onVoiceActivity;
    this.onError = onError;
    this.onPeerState = onPeerState; // (peerId, state) — 'connecting' | 'connected' | 'failed'
    this.peers = new Map(); // peerId -> RTCPeerConnection
    this.initiatorOf = new Set(); // peer ids where WE created the original offer
    this.disconnectTimers = new Map(); // peerId -> Timeout for ICE-restart grace
    this.localStream = null;
    this.destroyed = false;
    this.myId = null; // set by setMyId() — used for polite-peer tie-break on glare

    this.speakingState = new Map(); // peerId -> bool (last reported)
    this.speakingPoll = null;

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
      if (this.destroyed || this.peers.size === 0) return;
      for (const [peerId, pc] of this.peers) {
        try {
          const stats = await pc.getStats();
          let level = 0;
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
              if (typeof report.audioLevel === 'number' && report.audioLevel > level) {
                level = report.audioLevel;
              }
            }
          });
          const speaking = level >= SPEAKING_THRESHOLD;
          if (this.speakingState.get(peerId) !== speaking) {
            this.speakingState.set(peerId, speaking);
            this.onVoiceActivity?.(peerId, speaking);
          }
        } catch (_) { /* getStats can throw mid-teardown; ignore */ }
      }
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
      return this.localStream;
    } catch (err) {
      this._reportError('getUserMedia', err);
      throw err;
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

    // Offer glare: we already have a peer connection mid-negotiation with this
    // peer. Perfect-negotiation tie-break — the lexicographically smaller id is
    // "polite" and yields; the impolite side ignores the incoming offer.
    const existing = this.peers.get(msg.from);
    if (existing && existing.signalingState === 'have-local-offer') {
      // Tie-break: smaller id yields ("polite"). If we don't yet know our own
      // id (race on the very first peer_list), default to polite so we accept
      // the remote offer — better one-sided rollback than a mutual stall.
      const polite = !this.myId || this.myId < msg.from;
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
    if (__DEV__) {
      console.warn(`[WebRTC] ${stage} failed${peerId ? ` for ${peerId}` : ''}:`, err?.message ?? err);
    }
    if (fatal) this.onError?.({ stage, peerId, error: err });
  }

  // Public: useIntercom calls this from its own peer_left handler so we don't
  // clobber whatever else is registered on the signaling handlers object.
  handlePeerLeft(peerId) {
    this._removePeer(peerId);
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
    this._stopSpeakingPoll();
    this.peers.forEach((pc) => {
      try { pc.close(); } catch (_) { /* already closed */ }
    });
    this.peers.clear();
    this.localStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) { /* ignore */ }
    });
    this.localStream = null;
  }
}
