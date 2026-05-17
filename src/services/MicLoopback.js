/**
 * Local-only WebRTC loopback for mic monitoring.
 *
 * Currently only HomeScreen's mic-test consumes this — user-visible audible
 * loopback (speakerphone on, remote track gain cranked) so the rider hears
 * themselves. The silent path is kept because a second consumer existed
 * historically (WebRTCManager local-stats PC) and may return if a future
 * react-native-webrtc bump needs a stable level pipeline that
 * react-native-audio-record can't satisfy.
 *
 * Returns `{ pcLocal, pcRemote }` — caller closes both on teardown.
 * Throws on failure; caller is responsible for cleanup of any partial state.
 */
import { RTCPeerConnection } from 'react-native-webrtc';

const LOOPBACK_RTC_CONFIG = { iceServers: [] };

/**
 * @param {MediaStream} stream - local mic stream (already acquired)
 * @param {Object} opts
 * @param {boolean} [opts.audible=false] - if true, leave remote track playing
 *   and boost its volume (mic-test path). If false, mute the remote receiver
 *   immediately to prevent feedback (stats-only path).
 * @param {(error: Error) => void} [opts.onIceError] - called with non-fatal
 *   ICE candidate errors. Default: swallow.
 */
export async function buildLoopbackPair(stream, opts = {}) {
  const { audible = false, onIceError } = opts;
  const swallow = (err) => { try { onIceError?.(err); } catch (_) { /* ignore */ } };

  const pcLocal = new RTCPeerConnection(LOOPBACK_RTC_CONFIG);
  const pcRemote = new RTCPeerConnection(LOOPBACK_RTC_CONFIG);

  const wireIce = (src, dst, label) => {
    src.addEventListener?.('icecandidate', (e) => {
      if (!e.candidate) return;
      try {
        const p = dst.addIceCandidate(e.candidate);
        if (p && typeof p.catch === 'function') p.catch((err) => swallow(new Error(`${label}: ${err?.message ?? err}`)));
      } catch (err) {
        swallow(new Error(`${label}: ${err?.message ?? err}`));
      }
    });
  };
  wireIce(pcLocal, pcRemote, 'addIce(remote)');
  wireIce(pcRemote, pcLocal, 'addIce(local)');

  pcRemote.addEventListener?.('track', (e) => {
    const track = e?.track;
    if (!track) return;
    if (audible) {
      // react-native-webrtc routes remote audio to the earpiece by default —
      // crank the gain so monitor playback is audible at speakerphone volume.
      if (typeof track._setVolume === 'function') {
        try { track._setVolume(10); } catch (_) { /* ignore */ }
      }
    } else {
      // Stats-only path: mute the received track so the rider doesn't hear
      // their own mic looped back through the device speaker.
      try { track.enabled = false; } catch (_) { /* ignore */ }
    }
  });

  stream.getTracks().forEach((t) => pcLocal.addTrack(t, stream));

  const offer = await pcLocal.createOffer({});
  await pcLocal.setLocalDescription(offer);
  await pcRemote.setRemoteDescription(offer);
  if (!audible) {
    // Some react-native-webrtc builds auto-play decoded audio between
    // setLocalDescription(answer) and the 'track' event — disable receivers
    // BEFORE the answer is set to close that few-ms loopback window.
    try {
      pcRemote.getReceivers?.().forEach((r) => {
        if (r?.track) { try { r.track.enabled = false; } catch (_) { /* ignore */ } }
      });
    } catch (_) { /* ignore */ }
  }
  const answer = await pcRemote.createAnswer();
  await pcRemote.setLocalDescription(answer);
  await pcLocal.setRemoteDescription(answer);

  return { pcLocal, pcRemote };
}
