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
    this.localStream = null;
    this.destroyed = false;
    this.myId = null; // set by setMyId() — used for polite-peer tie-break on glare

    this._bindSignalingHandlers();
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

  async _handleOffer(msg) {
    if (this.destroyed) return;

    // Offer glare: we already have a peer connection mid-negotiation with this
    // peer. Perfect-negotiation tie-break — the lexicographically smaller id is
    // "polite" and yields; the impolite side ignores the incoming offer.
    const existing = this.peers.get(msg.from);
    if (existing && existing.signalingState === 'have-local-offer') {
      const polite = this.myId && this.myId < msg.from;
      if (!polite) {
        if (__DEV__) console.warn('[WebRTC] glare: ignoring offer from', msg.from);
        return;
      }
      // Polite side: drop our in-flight offer and accept theirs.
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

    pc.ontrack = ({ streams }) => {
      // Attach remote audio stream — react-native-webrtc handles playback
      this.onVoiceActivity?.(peerId, streams[0]);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      // Map RTC's many states to the three we surface to the UI.
      if (state === 'connecting' || state === 'new') {
        this.onPeerState?.(peerId, 'connecting');
      } else if (state === 'connected') {
        this.onPeerState?.(peerId, 'connected');
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.onPeerState?.(peerId, 'failed');
        if (state === 'failed' || state === 'disconnected') {
          this._removePeer(peerId);
        }
      }
    };

    this.peers.set(peerId, pc);
    this.onPeerState?.(peerId, 'connecting');
    return pc;
  }

  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) { /* already closed */ }
      this.peers.delete(peerId);
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
