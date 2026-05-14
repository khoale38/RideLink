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

let currentListener = null;
let initialized = false;
let running = false;
let listenerAttached = false;

function ensureListenerAttached() {
  if (listenerAttached || !emitter) return;
  emitter.addListener('data', (raw) => {
    if (currentListener) currentListener(raw);
  });
  listenerAttached = true;
}

export const Recorder = {
  configure(options) {
    if (!RNAudioRecord) return;
    RNAudioRecord.init(options);
    initialized = true;
    ensureListenerAttached();
  },

  setListener(fn) {
    currentListener = fn;
  },

  start() {
    if (!RNAudioRecord || !initialized) return false;
    if (running) return true;
    RNAudioRecord.start();
    running = true;
    return true;
  },

  stop() {
    if (!RNAudioRecord || !running) return;
    try { RNAudioRecord.stop(); } catch (_) { /* ignore */ }
    running = false;
  },

  isRunning() {
    return running;
  },
};
