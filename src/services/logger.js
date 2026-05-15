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

export const logger = {
  // Non-fatal: something unexpected but recoverable (signaling reconnect,
  // candidate parse failure, glare ignored, etc.).
  warn(scope, message, extra) {
    if (__DEV__) {
      console.warn(`[${scope}] ${message}`, extra ?? '');
    }
    breadcrumbHook?.({ level: 'warning', scope, message, extra });
  },

  // Fatal-ish: an error path users care about (mic denied, hotspot connect
  // failed, RTC setup blew up). In prod these should be captured.
  error(scope, err, extra) {
    if (__DEV__) {
      console.warn(`[${scope}] ${err?.message ?? err}`, extra ?? '');
    }
    breadcrumbHook?.({ level: 'error', scope, err, extra });
  },

  // Diagnostic — only in dev.
  info(scope, message, extra) {
    if (__DEV__) {
      console.log(`[${scope}] ${message}`, extra ?? '');
    }
  },

  // Set once at app start to forward to a real reporter.
  setReporter(fn) {
    breadcrumbHook = fn;
  },
};
