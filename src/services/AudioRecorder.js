/**
 * Thin wrapper around react-native-audio-record that talks to the native
 * RNAudioRecord module directly and installs ONE permanent data listener.
 *
 * Why not just use AudioRecord.on(): the library's helper calls
 * EventEmitter.removeAllListeners() every time, which on RN's new
 * architecture (TurboModules) desyncs the RCTEventEmitter listener
 * counter and crashes with "Attempted to remove more RNAudioRecord
 * listeners than added". We never call removeListeners — the listener
 * lives for the lifetime of the JS bundle, and useVOX just swaps the
 * callback target via setListener().
 */
import { NativeEventEmitter, NativeModules } from 'react-native';

const { RNAudioRecord } = NativeModules;
const emitter = RNAudioRecord ? new NativeEventEmitter(RNAudioRecord) : null;

// Module-level state is rebuilt on every Fast Refresh, which on RN's new
// architecture would re-call emitter.addListener and desync the native
// RCTEventEmitter listener counter (the very bug this file exists to avoid).
// Pin shared state on globalThis so a dev-time reload reuses the existing
// native subscription instead of allocating a second one. The callback is
// looked up via the shared object so a refreshed module body still routes
// frames to whichever `setListener(fn)` was called last.
const SHARED = globalThis.__RIDELINK_AUDIO_RECORDER__ ?? (globalThis.__RIDELINK_AUDIO_RECORDER__ = {
  currentListener: null,
  initialized: false,
  running: false,
  listenerAttached: false,
});

function ensureListenerAttached() {
  if (SHARED.listenerAttached || !emitter) return;
  emitter.addListener('data', (raw) => {
    if (SHARED.currentListener) SHARED.currentListener(raw);
  });
  SHARED.listenerAttached = true;
}

export const Recorder = {
  configure(options) {
    if (!RNAudioRecord) return;
    RNAudioRecord.init(options);
    SHARED.initialized = true;
    ensureListenerAttached();
  },

  setListener(fn) {
    SHARED.currentListener = fn;
  },

  start() {
    if (!RNAudioRecord || !SHARED.initialized) return false;
    if (SHARED.running) return true;
    RNAudioRecord.start();
    SHARED.running = true;
    return true;
  },

  stop() {
    if (!RNAudioRecord || !SHARED.running) return;
    try { RNAudioRecord.stop(); } catch (_) { /* ignore */ }
    SHARED.running = false;
  },

  isRunning() {
    return SHARED.running;
  },
};
