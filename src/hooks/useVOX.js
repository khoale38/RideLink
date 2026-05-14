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
import { useRef, useState, useEffect } from 'react';
import { Platform } from 'react-native';
import { Recorder } from '../services/AudioRecorder';

// iOS only allows one active audio input route at a time. WebRTC holds the
// mic via getUserMedia, so opening RNAudioRecord in parallel either fails or
// degrades the WebRTC capture. We skip the level meter on iOS and report
// "always speaking" so the audio track stays open whenever VOX is enabled.
const VOX_LEVEL_AVAILABLE = Platform.OS !== 'ios';

const SAMPLE_RATE = 8000;        // Hz — low enough for level-only monitoring
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HOLD_MS = 800;             // keep open this long after last loud frame
const DEFAULT_THRESHOLD_DB = -40;

// NOTE: useVOX only observes mic amplitude and reports `speaking`.
// It does NOT mutate track.enabled — that's owned by App.tsx, which knows
// about muted/voxEnabled/speaking together and is the single source of truth.
export function useVOX(localStream, enabled = true) {
  const [speaking, setSpeaking] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);

  const thresholdRef = useRef(thresholdDb);
  const holdTimer = useRef(null);
  const speakingRef = useRef(false);

  useEffect(() => { thresholdRef.current = thresholdDb; }, [thresholdDb]);

  useEffect(() => {
    if (!enabled || !localStream) {
      speakingRef.current = false;
      setSpeaking(false);
      return;
    }

    // iOS: can't read mic level without conflicting with WebRTC. The gate is
    // permanently open at the App.tsx level (see `transmit` below), but we
    // do NOT report `speaking: true` for the UI — the green border is for
    // actual voice activity, which we can't detect on iOS. Riders will see
    // it light up on the OTHER iOS rider's row when they actually talk
    // (driven by WebRTCManager's ontrack-derived "speaking" for remotes).
    if (!VOX_LEVEL_AVAILABLE) return;

    const setGate = (open) => {
      if (speakingRef.current === open) return;
      speakingRef.current = open;
      setSpeaking(open);
    };

    const onAudioData = (data) => {
      const db = _rmsDb(data);
      if (db >= thresholdRef.current) {
        clearTimeout(holdTimer.current);
        setGate(true);
        holdTimer.current = setTimeout(() => setGate(false), HOLD_MS);
      }
    };

    try {
      Recorder.configure({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE,
        wavFile: '',
      });
      Recorder.setListener(onAudioData);
      Recorder.start();
    } catch (err) {
      if (__DEV__) console.warn('[VOX] failed to start AudioRecord:', err?.message ?? err);
    }

    return () => {
      Recorder.setListener(null);
      Recorder.stop();
      clearTimeout(holdTimer.current);
      speakingRef.current = false;
      setSpeaking(false);
    };
  }, [enabled, localStream]);

  // `speaking`: should the UI show a "speaking" indicator (real voice activity).
  // `transmit`: should the audio track be enabled — true on iOS where we can't
  //   measure level, or follows `speaking` on Android where VOX is gating.
  const transmit = VOX_LEVEL_AVAILABLE ? speaking : true;
  return {
    speaking,
    transmit,
    thresholdDb,
    setThresholdDb,
    levelAvailable: VOX_LEVEL_AVAILABLE,
  };
}

// Parse raw base64 PCM-16 → RMS in dBFS
function _rmsDb(base64) {
  try {
    // atob is provided by Hermes/JSC at runtime in RN 0.72+; the default
    // @react-native ESLint preset doesn't know that — silence the warning.
    // eslint-disable-next-line no-undef
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
