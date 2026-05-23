/**
 * VOX (Voice-Activated Transmit)
 *
 * Drives the self-speaking indicator and the per-peer transmit gate from the
 * WebRTC source's own `media-source.audioLevel`, surfaced as a subscribable
 * stream by WebRTCManager (via useIntercom). Same data source the working
 * remote-speaker poll already uses for other riders, so iOS and Android behave
 * identically — no second AudioRecord client to arbitrate against on Android.
 *
 * The stats-only loopback pc in WebRTCManager keeps the source attached to a
 * (silent) sender so `media-source.audioLevel` keeps reporting even while the
 * real peer senders are gated to null by setTransmitting(false). Without that
 * loopback, closing the gate would zero the level and deadlock VOX shut.
 *
 * dBFS thresholds (UI-driven):
 *   -50 dB  = very sensitive (quiet room)
 *   -40 dB  = default (light wind / normal speech)
 *   -30 dB  = less sensitive (loud wind / highway)
 */
import { useRef, useState, useEffect } from 'react';
import { logger } from '../services/logger';

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

// Level subscription must produce at least one audible sample within this
// window or calibration fails open (transmit=true). Larger than the 2.5s
// calibration window itself because we may need to wait for the stats-only
// loopback pc to negotiate before the first audioLevel report arrives.
const CALIBRATION_WATCHDOG_MS = 8000;

// NOTE: useVOX only observes mic amplitude and reports `speaking`.
// It does NOT mutate track.enabled — that's owned by App.tsx, which knows
// about muted/voxEnabled/speaking together and is the single source of truth.
//
// `subscribeLocalLevel(cb)` is the level-stream subscription handed back by
// useIntercom. `cb` is called with audioLevel in [0,1] each stats tick.
// Returning `null`/`undefined` from `subscribe` is treated as "no level pipe
// available yet" (e.g. session not started) and disables gating.
export function useVOX(subscribeLocalLevel, enabled = true) {
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
    if (!enabled || typeof subscribeLocalLevel !== 'function') {
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

    // Cross-platform calibration watchdog: a truly silent room (or a stats
    // pipe that never delivers — e.g. no peer connected, loopback failed to
    // build) leaves calibrationDoneAt unset and the rider stuck gated shut.
    // This timer is the only escape.
    const calibrationWatchdog = calibrationActive
      ? setTimeout(() => {
          if (!calibrationActive) return;
          if (calibrationSamples.length === 0) {
            logger.warn('VOX', 'calibration window elapsed with no audible samples — falling back to fail-open transmit');
            calibrationActive = false;
            setCalibrating(false);
            setCalibrationFailed(true);
          } else {
            finishCalibration();
          }
        }, CALIBRATION_WATCHDOG_MS)
      : null;

    let unsubscribe = null;
    try {
      unsubscribe = subscribeLocalLevel((level) => {
        // audioLevel is linear amplitude 0..1. 0 and non-finite become
        // -Infinity in dB — onSample filters those during calibration so a
        // pre-loopback-up tick can't poison the noise-floor sample set.
        const db = _audioLevelToDb(level);
        onSample(db);
      });
    } catch (err) {
      if (__DEV__) console.warn('[VOX] subscribeLocalLevel threw:', err?.message ?? err);
    }

    return () => {
      if (calibrationWatchdog) clearTimeout(calibrationWatchdog);
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_) { /* ignore */ }
      }
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
  }, [enabled, subscribeLocalLevel, recalibrateNonce]);

  // `speaking`: should the UI show a "speaking" indicator (real voice activity).
  // `transmit`: should the audio track be enabled — follows `speaking`.
  //
  // Fail-safe: if calibration times out with no audible samples (mic
  // permission denied, no peer connected yet so the stats loopback never
  // negotiated, truly silent room), keep transmit=true so the intercom is at
  // least usable.
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

// audioLevel from getStats() is linear amplitude 0..1. Convert to dBFS.
function _audioLevelToDb(level) {
  if (typeof level !== 'number' || !isFinite(level) || level <= 0) return -Infinity;
  return 20 * Math.log10(level);
}
