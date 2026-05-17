/**
 * App-wide logger — single seam for crash reporters (Sentry / Bugsnag / etc.)
 *
 * Currently a thin wrapper over console with __DEV__ gating. Replace the
 * bodies with your reporter's SDK calls when you wire one in, e.g.:
 *
 *   import * as Sentry from '@sentry/react-native';
 *   ...
 *   error(scope, err, extra) {
 *     Sentry.captureException(err, { tags: { scope }, extra });
 *   }
 *
 * Call sites should use `logger.warn/error` instead of `if (__DEV__) console.warn`
 * so prod failures surface in your reporter dashboard instead of vanishing.
 */

let breadcrumbHook = null;

// Numeric levels — anything below `minLevel` is suppressed entirely. Default
// is 'warn' in production so info-level chatter doesn't balloon the journal
// (per-peer overflow warnings, sibling-handler throws, transient ICE errors)
// while still surfacing real problems. Bump to 'info' for verbose debugging.
const LEVELS = { info: 10, warn: 20, error: 30 };
let minLevel = LEVELS.warn;

// Per-key rate limiter for the noisiest warn lines. Caller passes a stable
// `dedupeKey` to logger.warn — repeats within RATE_WINDOW_MS are dropped.
// Without this, a flapping network can produce hundreds of identical lines
// per minute and bury anything actionable.
const RATE_WINDOW_MS = 5000;
const lastEmitted = new Map();
function shouldEmit(key) {
  if (!key) return true;
  const now = Date.now();
  const prev = lastEmitted.get(key) ?? 0;
  if (now - prev < RATE_WINDOW_MS) return false;
  lastEmitted.set(key, now);
  // Bound the map — a long-running session with many unique keys could
  // otherwise grow unbounded. Evict the oldest half when we cross 256.
  if (lastEmitted.size > 256) {
    const entries = Array.from(lastEmitted.entries()).sort((a, b) => a[1] - b[1]);
    entries.slice(0, 128).forEach(([k]) => lastEmitted.delete(k));
  }
  return true;
}

export const logger = {
  // Non-fatal: something unexpected but recoverable (signaling reconnect,
  // candidate parse failure, glare ignored, etc.).
  warn(scope, message, extra) {
    if (LEVELS.warn < minLevel) return;
    // Allow callers to pass a `dedupeKey` on the extra object for
    // rate-limited warnings (e.g. per-peer overflow). Absent key → always
    // emit, preserving prior behavior for one-shot warnings.
    if (!shouldEmit(extra?.dedupeKey)) return;
    if (__DEV__) {
      console.warn(`[${scope}] ${message}`, extra ?? '');
    }
    breadcrumbHook?.({ level: 'warning', scope, message, extra });
  },

  // Fatal-ish: an error path users care about (mic denied, hotspot connect
  // failed, RTC setup blew up). In prod these should be captured.
  error(scope, err, extra) {
    if (LEVELS.error < minLevel) return;
    if (__DEV__) {
      console.warn(`[${scope}] ${err?.message ?? err}`, extra ?? '');
    }
    breadcrumbHook?.({ level: 'error', scope, err, extra });
  },

  // Diagnostic — only in dev.
  info(scope, message, extra) {
    if (LEVELS.info < minLevel) return;
    if (__DEV__) {
      console.log(`[${scope}] ${message}`, extra ?? '');
    }
  },

  // Set once at app start to forward to a real reporter.
  setReporter(fn) {
    breadcrumbHook = fn;
  },

  // Override the min level at runtime. Accepts 'info' | 'warn' | 'error'.
  // Useful for a debug-build toggle or QA session.
  setLevel(level) {
    if (LEVELS[level]) minLevel = LEVELS[level];
  },
};
