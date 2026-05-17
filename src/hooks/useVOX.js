/**
 * VOX (Voice-Activated Transmit)
 *
 * Both platforms monitor mic amplitude via react-native-audio-record (PCM
 * frames). On iOS, AudioToolbox sits alongside WebRTC's PlayAndRecord
 * AVAudioSession without conflict and gives a stable per-frame level.
 *
 * dBFS thresholds (UI-driven):
 *   -50 dB  = very sensitive (quiet room)
 *   -40 dB  = default (light wind / normal speech)
 *   -30 dB  = less sensitive (loud wind / highway)
 */
import { useRef, useState, useEffect } from 'react';
import { Recorder } from '../services/AudioRecorder';
import { logger } from '../services/logger';

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
export function useVOX(localStream, enabled = true) {
  const [speaking, setSpeaking] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationFailed, setCalibrationFailed] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);
  const [recalibrateNonce, setRecalibrateNonce] = useState(0);

  const thresholdRef = useRef(thresholdDb);
  const holdTimer = useRef(null);
  const speakingRef = useRef(false);
  // Mirrored as a ref so finishCalibration() can see slider moves that
  // happened mid-calibration without forcing the effect to re-run on every
  // manualOverride change (which would restart calibration).
  const manualOverrideRef = useRef(manualOverride);

  useEffect(() => { thresholdRef.current = thresholdDb; }, [thresholdDb]);
  useEffect(() => { manualOverrideRef.current = manualOverride; }, [manualOverride]);

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
    // The deadline is anchored to the FIRST finite sample (set once, never
    // pushed forward) so a transient zero mid-calibration can't re-arm it.
    let calibrationActive = !manualOverride;
    const calibrationSamples = [];
    let calibrationDoneAt = 0; // set on first finite sample
    if (calibrationActive) setCalibrating(true);

    const finishCalibration = () => {
      calibrationActive = false;
      setCalibrating(false);
      // If the rider moved the slider while calibration was running, respect
      // their manual value — don't clobber it with the auto result.
      if (manualOverrideRef.current) return;
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
        if (isFinite(db)) {
          // Anchor the deadline on the first audible sample so the window
          // is "first sample → first sample + CALIBRATION_MS" regardless of
          // how long we waited for stats / mic frames to start flowing.
          if (calibrationDoneAt === 0) calibrationDoneAt = Date.now() + CALIBRATION_MS;
          calibrationSamples.push(db);
        }
        if (calibrationDoneAt > 0 && Date.now() >= calibrationDoneAt) finishCalibration();
        return; // don't gate during calibration
      }
      if (db >= thresholdRef.current) {
        clearTimeout(holdTimer.current);
        setGate(true);
        holdTimer.current = setTimeout(() => setGate(false), HOLD_MS);
      }
    };

    let stopRecorder = null;
    // Cross-platform calibration watchdog: a truly silent room makes
    // _rmsDb() return -Infinity, which onSample() drops as non-finite —
    // calibrationDoneAt is never set and the rider stays gated shut. This
    // timer is the only escape.
    const calibrationWatchdog = calibrationActive
      ? setTimeout(() => {
          if (!calibrationActive) return;
          if (calibrationSamples.length === 0) {
            logger.warn('VOX', 'calibration window elapsed with no audible samples — using default threshold');
            calibrationActive = false;
            setCalibrating(false);
            setCalibrationFailed(true);
          } else {
            finishCalibration();
          }
        }, 8000)
      : null;
    // Acquire ownership of the singleton Recorder for this effect run.
    // Preempts any prior owner — their cleanup will see a stale token and
    // skip the stop(), so the live session keeps running. Our cleanup
    // passes the same token so it only tears down if we still own it.
    const token = Recorder.acquire();
    try {
      // Recorder state lives on globalThis (survives Fast Refresh / hook
      // remount). A prior session that didn't reach its cleanup could leave
      // `running` true; force-stop here so start() reliably re-arms the
      // native capture rather than no-oping. We just acquired the token so
      // these calls are authorized.
      // Clear the listener BEFORE stopping so an in-flight frame from the
      // prior session can't fire one last onSample() against the new
      // session's closures (calibrationActive / thresholdRef captured by
      // this effect's scope). Then stop the recorder itself.
      try { Recorder.setListener(null, token); } catch (_) { /* ignore */ }
      try { Recorder.stop(token); } catch (_) { /* ignore */ }
      Recorder.configure({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        bitsPerSample: BITS_PER_SAMPLE,
        wavFile: '',
      }, token);
      Recorder.setListener((data) => onSample(_rmsDb(data)), token);
      Recorder.start(token);
      let stopped = false;
      stopRecorder = () => {
        if (stopped) return;
        stopped = true;
        // Token-guarded: if another useVOX has preempted us, these become
        // no-ops and we leave the new owner's session running.
        try { Recorder.setListener(null, token); } catch (_) { /* ignore */ }
        try { Recorder.stop(token); } catch (_) { /* ignore */ }
      };
    } catch (err) {
      if (__DEV__) console.warn('[VOX] failed to start AudioRecord:', err?.message ?? err);
    }

    return () => {
      if (calibrationWatchdog) clearTimeout(calibrationWatchdog);
      if (stopRecorder) stopRecorder();
      clearTimeout(holdTimer.current);
      speakingRef.current = false;
      setSpeaking(false);
    };
    // INVARIANT: `manualOverride` is intentionally not in the dep array —
    // the only path that should restart calibration is `recalibrate()`,
    // which flips manualOverride=false AND increments recalibrateNonce.
    // A future caller that sets manualOverride directly would need to also
    // increment the nonce (or be added here) to retrigger calibration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, localStream, recalibrateNonce]);

  // `speaking`: should the UI show a "speaking" indicator (real voice activity).
  // `transmit`: should the audio track be enabled — follows `speaking`.
  //
  // Fail-safe: if calibration times out with no audible samples (mic
  // permission denied, recorder failed to start, truly silent room), keep
  // transmit=true so the intercom is at least usable.
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
