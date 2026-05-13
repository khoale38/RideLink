/**
 * VOX (Voice-Activated Transmit)
 *
 * Monitors mic amplitude via react-native-audio-record (low-rate PCM).
 * Gates the WebRTC audio track open/closed based on a dB threshold.
 *
 * Typical thresholds:
 *   -50 dB  = very sensitive (quiet room)
 *   -40 dB  = default (light wind / normal speech)
 *   -30 dB  = less sensitive (loud wind / highway)
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import AudioRecord from 'react-native-audio-record';

const SAMPLE_RATE = 8000;        // Hz — low enough for level-only monitoring
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HOLD_MS = 800;             // keep open this long after last loud frame
const DEFAULT_THRESHOLD_DB = -40;

export function useVOX(localStream, enabled = true) {
  const [speaking, setSpeaking] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  const holdTimer = useRef(null);
  const speakingRef = useRef(false);

  const _setGate = useCallback((open) => {
    if (speakingRef.current === open) return;
    speakingRef.current = open;
    setSpeaking(open);

    const track = localStream?.getAudioTracks()[0];
    if (track) track.enabled = open;
  }, [localStream]);

  const _onAudioData = useCallback((data) => {
    const db = _rmsDb(data);

    if (db >= thresholdDb) {
      // Above threshold — open gate immediately
      clearTimeout(holdTimer.current);
      _setGate(true);

      // Restart hold timer
      holdTimer.current = setTimeout(() => _setGate(false), HOLD_MS);
    }
    // Below threshold: hold timer will close gate after HOLD_MS
  }, [thresholdDb, _setGate]);

  useEffect(() => {
    if (!enabled || !localStream) return;

    AudioRecord.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      wavFile: '', // no file, stream only
    });

    AudioRecord.on('data', _onAudioData);
    AudioRecord.start();

    return () => {
      AudioRecord.stop();
      clearTimeout(holdTimer.current);
      // Re-enable track on unmount so mute state doesn't stick
      const track = localStream?.getAudioTracks()[0];
      if (track) track.enabled = true;
    };
  }, [enabled, localStream, _onAudioData]);

  return { speaking, thresholdDb, setThresholdDb };
}

// Parse raw base64 PCM-16 → RMS in dBFS
function _rmsDb(base64) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const samples = new Int16Array(bytes.buffer);
    if (samples.length === 0) return -Infinity;

    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const norm = samples[i] / 32768;
      sum += norm * norm;
    }
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  } catch {
    return -Infinity;
  }
}
