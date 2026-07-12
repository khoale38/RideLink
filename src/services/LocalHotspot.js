import { NativeModules, Platform } from 'react-native';

const { LocalHotspot } = NativeModules;

// On some OEMs the LocalOnlyHotspot callback never fires (e.g. location
// services off), leaving the bridge promise unsettled — hostGroup would then
// hang on `await` forever with the UI stuck on busy. Cap the wait; a timeout
// falls back to the manual-hotspot flow. If onStarted fires late, the native
// side still holds the reservation and stopLocalHotspot() on session cleanup
// closes it.
const START_TIMEOUT_MS = 10000;

// LocalOnlyHotspot is Android-only. Returns { ssid, password } on success, or
// null on platforms / failures / timeout where we should fall back to the
// manual flow.
export async function startLocalHotspot() {
  if (Platform.OS !== 'android' || !LocalHotspot) return null;
  let timer = null;
  try {
    const startPromise = LocalHotspot.start();
    // A rejection landing after the timeout won the race must not surface as
    // an unhandled rejection.
    startPromise.catch(() => {});
    const info = await Promise.race([
      startPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), START_TIMEOUT_MS); }),
    ]);
    if (!info?.ssid) return null;
    return { ssid: stripQuotes(info.ssid), password: info.password ?? '' };
  } catch (err) {
    if (__DEV__) console.warn('[LocalHotspot] start failed:', err?.message ?? err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopLocalHotspot() {
  if (Platform.OS !== 'android' || !LocalHotspot) return;
  try {
    await LocalHotspot.stop();
  } catch (err) {
    if (__DEV__) console.warn('[LocalHotspot] stop failed:', err?.message ?? err);
  }
}

// WifiConfiguration.SSID comes back wrapped in literal quotes on older APIs.
function stripQuotes(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
