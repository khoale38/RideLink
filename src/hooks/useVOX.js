/**
 * VOX (Voice-Activated Transmit)
 *
 * Android: monitors mic amplitude via react-native-audio-record (PCM frames).
 * iOS:     reads WebRTC `getStats()` media-source audioLevel (0..1), which
 *          doesn't require opening a parallel mic capture (which would
 *          conflict with WebRTC's AVAudioSession).
 *
 * Both paths normalize to dBFS so the threshold UI is identical:
 *   -50 dB  = very sensitive (quiet room)
 *   -40 dB  = default (light wind / normal speech)
 *   -30 dB  = less sensitive (loud wind / highway)
 */
import { useRef, useState, useEffect } from 'react';
import { Platform } from 'react-native';
import { Recorder } from '../services/AudioRecorder';
import { logger } from '../services/logger';

const IS_IOS = Platform.OS === 'ios';
// iOS polls a level ref the WebRTCManager fills via getStats. Cadence matches
// the manager's poll (~300ms). Slightly slower attack than Android PCM but
// avoids the AVAudioSession conflict.
const IOS_POLL_MS = 150;

const SAMPLE_RATE = 8000;        // Hz — low enough for level-only monitoring
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HOLD_MS = 800;             // keep open this long after last loud frame
const DEFAULT_THRESHOLD_DB = -40;

// Auto-calibration: sample the noise floor while the rider stays quiet, then
// set the threshold above it so wind/engine doesn't trip the gate. The rider
// should be silent for this window — surfaced via `calibrating` to the UI.
const CALIBRATION_MS = 2500;
const CALIBRATION_MARGIN_DB = 8;     // threshold = noiseFloorDb + margin
const CALIBRATION_FLOOR_PCT = 0.9;   // 90th percentile of frames → noise floor
const CALIBRATION_MIN_DB = -55;      // clamp so silent rooms don't gate at -inf
const CALIBRATION_MAX_DB = -20;      // clamp so a noisy probe doesn't lock VOX shut

// NOTE: useVOX only observes mic amplitude and reports `speaking`.
// It does NOT mutate track.enabled — that's owned by App.tsx, which knows
// about muted/voxEnabled/speaking together and is the single source of truth.
export function useVOX(localStream, enabled = true, localLevelRef = null) {
  const [speaking, setSpeaking] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationFailed, setCalibrationFailed] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);
  const [recalibrateNonce, setRecalibrateNonce] = useState(0);

  const thresholdRef = useRef(thresholdDb);
  const holdTimer = useRef(null);
  const speakingRef = useRef(false);

  useEffect(() => { thresholdRef.current = thresholdDb; }, [thresholdDb]);

  // Wrap setThresholdDb so any manual move flips us out of auto-mode.
  const setThresholdDbManual = (db) => {
    setManualOverride(true);
    setThresholdDb(db);
  };

  // Trigger a fresh calibration pass on demand. Also re-enables auto-mode so
  // the new value sticks instead of being overridden by a stale manual value.
  const recalibrate = () => {
    setManualOverride(false);
    setCalibrationFailed(false);
    setRecalibrateNonce((n) => n + 1);
  };

  useEffect(() => {
    if (!enabled || !localStream) {
      speakingRef.current = false;
      setSpeaking(false);
      return;
    }

    const setGate = (open) => {
      if (speakingRef.current === open) return;
      speakingRef.current = open;
      setSpeaking(open);
    };

    // Calibration window state — sample the noise floor before gating starts.
    // Skipped when the user has manually moved the slider this session.
    let calibrationActive = !manualOverride;
    const calibrationSamples = [];
    let calibrationDoneAt = calibrationActive ? Date.now() + CALIBRATION_MS : 0;
    if (calibrationActive) setCalibrating(true);

    const finishCalibration = () => {
      calibrationActive = false;
      setCalibrating(false);
      if (calibrationSamples.length === 0) return;
      // 90th-percentile noise floor: ignore the loudest 10% of frames (in case
      // the rider coughed during calibration), then take the highest of what
      // remains as the "noise" baseline.
      const sorted = calibrationSamples
        .filter((v) => isFinite(v))
        .sort((a, b) => a - b);
      if (sorted.length === 0) return;
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * CALIBRATION_FLOOR_PCT));
      const floor = sorted[idx];
      const raw = floor + CALIBRATION_MARGIN_DB;
      const clamped = Math.max(CALIBRATION_MIN_DB, Math.min(CALIBRATION_MAX_DB, raw));
      if (__DEV__) console.warn(`[VOX] calibrated noise floor=${floor.toFixed(1)} dB → threshold=${clamped.toFixed(1)} dB`);
      setThresholdDb(clamped);
    };

    const onSample = (db) => {
      if (calibrationActive) {
        if (isFinite(db)) calibrationSamples.push(db);
        if (Date.now() >= calibrationDoneAt) finishCalibration();
        return; // don't gate during calibration
      }
      if (db >= thresholdRef.current) {
        clearTimeout(holdTimer.current);
        setGate(true);
        holdTimer.current = setTimeout(() => setGate(false), HOLD_MS);
      }
    };

    let iosTimer = null;
    let stopRecorder = null;
    if (IS_IOS) {
      // iOS path: poll the WebRTCManager-supplied level ref. No peer
      // connection → ref stays at 0 → calibration would lock at -inf, so we
      // wait until we see a non-zero sample before starting the timer.
      const startedAt = Date.now();
      const tick = () => {
        const level = localLevelRef?.current ?? 0;
        // 0..1 → dBFS. level=0 → -Infinity (silent / no pc yet).
        const db = level > 0 ? 20 * Math.log10(level) : -Infinity;
        // Defer calibration start until WebRTC stats are flowing.
        if (calibrationActive && calibrationSamples.length === 0 && !isFinite(db)) {
          calibrationDoneAt = Date.now() + CALIBRATION_MS;
          // Fallback: if no peer has connected after 8s, give up on
          // calibration so the rider isn't gated shut while waiting alone.
          // The default threshold takes over and the next recalibrate call
          // (or auto-recalibrate on next session) will replace it.
          if (Date.now() - startedAt > 8000) {
            logger.warn('VOX', 'no audio level yet — falling back to default threshold');
            calibrationActive = false;
            setCalibrating(false);
            setCalibrationFailed(true);
          }
          return;
        }
        onSample(db);
      };
      iosTimer = setInterval(tick, IOS_POLL_MS);
    } else {
      try {
        Recorder.configure({
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          bitsPerSample: BITS_PER_SAMPLE,
          wavFile: '',
        });
        Recorder.setListener((data) => onSample(_rmsDb(data)));
        Recorder.start();
        stopRecorder = () => {
          Recorder.setListener(null);
          Recorder.stop();
        };
      } catch (err) {
        if (__DEV__) console.warn('[VOX] failed to start AudioRecord:', err?.message ?? err);
      }
    }

    return () => {
      if (iosTimer) clearInterval(iosTimer);
      if (stopRecorder) stopRecorder();
      clearTimeout(holdTimer.current);
      speakingRef.current = false;
      setSpeaking(false);
    };
  }, [enabled, localStream, recalibrateNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // `speaking`: should the UI show a "speaking" indicator (real voice activity).
  // `transmit`: should the audio track be enabled — follows `speaking` on
  // both platforms now that iOS has its own (getStats-based) level path.
  //
  // Fail-safe: on iOS solo host, _localStatsPc may never produce an audioLevel
  // (no remote answer → no media-source stats on some react-native-webrtc
  // builds). After 8s VOX gives up calibration with calibrationFailed=true and
  // level stays at 0. Without this fallback the gate would stay shut forever
  // and the rider's audio would never transmit. Treat that case as "VOX off":
  // mic is always live, border always shown, so the intercom is at least
  // usable while we wait for a real peer to bring stats online.
  const voxUnavailable = calibrationFailed;
  const transmit = voxUnavailable ? true : speaking;
  // UI indicator must reflect actual voice activity — never force it on just
  // because we couldn't calibrate. Otherwise the "speaking" border lights up
  // permanently even when the rider is silent.
  return {
    speaking,
    transmit,
    thresholdDb,
    setThresholdDb: setThresholdDbManual,
    calibrating,
    calibrationFailed,
    recalibrate,
    levelAvailable: !voxUnavailable,
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
