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
  constructor(signalingClient, onVoiceActivity) {
    this.signaling = signalingClient;
    this.onVoiceActivity = onVoiceActivity;
    this.peers = new Map(); // peerId -> RTCPeerConnection
    this.localStream = null;

    this._bindSignalingHandlers();
  }

  async startLocalAudio() {
    this.localStream = await mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    return this.localStream;
  }

  async callPeer(peerId) {
    const pc = this._createPeerConnection(peerId);
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signaling.send({ type: 'offer', to: peerId, sdp: offer });
  }

  async _handleOffer(msg) {
    const pc = this._createPeerConnection(msg.from);
    this.localStream?.getTracks().forEach((t) => pc.addTrack(t, this.localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.signaling.send({ type: 'answer', to: msg.from, sdp: answer });
  }

  async _handleAnswer(msg) {
    const pc = this.peers.get(msg.from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  }

  async _handleIceCandidate(msg) {
    const pc = this.peers.get(msg.from);
    if (pc && msg.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  }

  _createPeerConnection(peerId) {
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
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._removePeer(peerId);
      }
    };

    this.peers.set(peerId, pc);
    return pc;
  }

  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) { pc.close(); this.peers.delete(peerId); }
  }

  _bindSignalingHandlers() {
    const handlers = this.signaling.handlers;
    handlers.offer = (msg) => this._handleOffer(msg);
    handlers.answer = (msg) => this._handleAnswer(msg);
    handlers.ice_candidate = (msg) => this._handleIceCandidate(msg);
    handlers.peer_left = (msg) => this._removePeer(msg.id);
  }

  destroy() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
