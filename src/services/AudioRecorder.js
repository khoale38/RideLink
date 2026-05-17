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
/* global globalThis */
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
  // Monotonic ownership token. Recorder is a singleton across Fast Refresh,
  // so two concurrent callers (e.g. transient HomeScreen→GroupScreen render
  // overlap, two useVOX hooks alive at once) could otherwise clobber each
  // other: the second's start() takes the listener, and the first's
  // cleanup stop()s the live session. Each caller acquires() a token; only
  // the current owner's setListener/start/stop have effect.
  ownerToken: 0,
  nextToken: 0,
});

function ensureListenerAttached() {
  if (SHARED.listenerAttached || !emitter) return;
  emitter.addListener('data', (raw) => {
    if (SHARED.currentListener) SHARED.currentListener(raw);
  });
  SHARED.listenerAttached = true;
}

export const Recorder = {
  // Acquire ownership. Preempts any prior owner — their subsequent
  // setListener/start/stop calls become no-ops, so a stale cleanup from
  // the previous owner can't tear down the new session.
  acquire() {
    SHARED.nextToken += 1;
    SHARED.ownerToken = SHARED.nextToken;
    return SHARED.ownerToken;
  },

  configure(options, token) {
    if (!RNAudioRecord) return;
    if (token !== undefined && token !== SHARED.ownerToken) return;
    RNAudioRecord.init(options);
    SHARED.initialized = true;
    ensureListenerAttached();
  },

  setListener(fn, token) {
    if (token !== undefined && token !== SHARED.ownerToken) return;
    SHARED.currentListener = fn;
  },

  start(token) {
    if (!RNAudioRecord || !SHARED.initialized) return false;
    if (token !== undefined && token !== SHARED.ownerToken) return false;
    if (SHARED.running) return true;
    RNAudioRecord.start();
    SHARED.running = true;
    return true;
  },

  stop(token) {
    if (!RNAudioRecord || !SHARED.running) return;
    if (token !== undefined && token !== SHARED.ownerToken) return;
    try { RNAudioRecord.stop(); } catch (_) { /* ignore */ }
    SHARED.running = false;
  },

  isRunning() {
    return SHARED.running;
  },
};
