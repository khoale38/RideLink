/**
 * Tests for useVOX driven by the subscribeLocalLevel pipe (post-RNAR refactor).
 *
 * The previous PCM-from-AudioRecord path returned zero buffers on Android
 * because Android arbitrates concurrent AudioRecord clients and WebRTC's
 * VOICE_COMMUNICATION source won — locking the gate shut forever. Now useVOX
 * reads `media-source.audioLevel` from the WebRTCManager stats-only loopback
 * (surfaced via useIntercom.subscribeLocalLevel), so behavior is identical on
 * both platforms.
 */
import { renderHook, act } from '@testing-library/react-hooks';
import { useVOX } from '../src/hooks/useVOX';

// Build a tiny pub/sub that mimics useIntercom.subscribeLocalLevel.
function makeLevelPipe() {
  const listeners = new Set();
  const subscribe = (cb) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };
  const emit = (level) => {
    for (const cb of listeners) cb(level);
  };
  return { subscribe, emit, listeners };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('starts calibrating when enabled and a level pipe is provided', () => {
  const { subscribe } = makeLevelPipe();
  const { result } = renderHook(() => useVOX(subscribe, true));
  expect(result.current.calibrating).toBe(true);
  expect(result.current.calibrationFailed).toBe(false);
  expect(result.current.speaking).toBe(false);
});

test('calibration finishes after CALIBRATION_MS of audible samples and gate opens on loud level', () => {
  const { subscribe, emit } = makeLevelPipe();
  const { result } = renderHook(() => useVOX(subscribe, true));

  // Feed a steady, quiet noise floor (~ -50 dBFS → level ≈ 0.00316). Anchor
  // the calibration timer on the first audible sample.
  act(() => { emit(0.00316); });
  // Wait out the calibration window — emit a few more during the window.
  for (let i = 0; i < 5; i++) {
    act(() => {
      jest.advanceTimersByTime(500);
      emit(0.00316);
    });
  }
  // One more sample past the deadline so finishCalibration fires inside onSample.
  act(() => { emit(0.00316); });

  expect(result.current.calibrating).toBe(false);
  // Threshold should land ~ -42 dB (-50 + 8 margin), clamped to [-55, -20].
  expect(result.current.thresholdDb).toBeGreaterThanOrEqual(-55);
  expect(result.current.thresholdDb).toBeLessThanOrEqual(-20);

  // Quiet sample below threshold → gate stays closed.
  act(() => { emit(0.001); });
  expect(result.current.speaking).toBe(false);

  // Loud sample above threshold → gate opens.
  act(() => { emit(0.5); }); // ~ -6 dB
  expect(result.current.speaking).toBe(true);
  expect(result.current.transmit).toBe(true);
});

test('calibration watchdog fails open (transmit=true) when no audible samples arrive', () => {
  // Simulates the host opening the app before any peer connects: the
  // loopback pc may not have negotiated yet, so the level pipe is silent.
  // VOX must fall back to fail-open transmit rather than gating shut forever.
  const { subscribe } = makeLevelPipe();
  const { result } = renderHook(() => useVOX(subscribe, true));

  act(() => { jest.advanceTimersByTime(8001); });

  expect(result.current.calibrationFailed).toBe(true);
  expect(result.current.calibrating).toBe(false);
  // Fail-open: gate is open so the intercom remains usable.
  expect(result.current.transmit).toBe(true);
  // Speaking indicator must still reflect REAL activity, not the fail-open
  // flag — otherwise the UI border lights up permanently.
  expect(result.current.speaking).toBe(false);
  expect(result.current.levelAvailable).toBe(false);
});

test('unsubscribes from the level pipe on unmount', () => {
  const { subscribe, listeners } = makeLevelPipe();
  const { unmount } = renderHook(() => useVOX(subscribe, true));
  expect(listeners.size).toBe(1);
  unmount();
  expect(listeners.size).toBe(0);
});

test('does not subscribe when disabled', () => {
  const { subscribe, listeners } = makeLevelPipe();
  renderHook(() => useVOX(subscribe, false));
  expect(listeners.size).toBe(0);
});

test('manual threshold move during calibration is respected and not clobbered', () => {
  const { subscribe, emit } = makeLevelPipe();
  const { result } = renderHook(() => useVOX(subscribe, true));
  expect(result.current.calibrating).toBe(true);

  act(() => { emit(0.001); });
  // User moves the slider mid-calibration.
  act(() => { result.current.setThresholdDb(-35); });
  // Finish the calibration window.
  for (let i = 0; i < 6; i++) {
    act(() => {
      jest.advanceTimersByTime(500);
      emit(0.001);
    });
  }

  expect(result.current.thresholdDb).toBe(-35);
});

test('recalibrate() restarts calibration and re-enables auto-mode', () => {
  const { subscribe, emit } = makeLevelPipe();
  const { result } = renderHook(() => useVOX(subscribe, true));
  // Time out calibration first to set calibrationFailed.
  act(() => { jest.advanceTimersByTime(8001); });
  expect(result.current.calibrationFailed).toBe(true);

  act(() => { result.current.recalibrate(); });
  expect(result.current.calibrating).toBe(true);
  expect(result.current.calibrationFailed).toBe(false);

  // Now feed audible samples so the new calibration completes.
  act(() => { emit(0.003); });
  for (let i = 0; i < 6; i++) {
    act(() => {
      jest.advanceTimersByTime(500);
      emit(0.003);
    });
  }
  expect(result.current.calibrating).toBe(false);
});
