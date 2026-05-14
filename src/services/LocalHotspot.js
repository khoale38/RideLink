import { NativeModules, Platform } from 'react-native';

const { LocalHotspot } = NativeModules;

// LocalOnlyHotspot is Android-only. Returns { ssid, password } on success, or
// null on platforms / failures where we should fall back to the manual flow.
export async function startLocalHotspot() {
  if (Platform.OS !== 'android' || !LocalHotspot) return null;
  try {
    const info = await LocalHotspot.start();
    if (!info?.ssid) return null;
    return { ssid: stripQuotes(info.ssid), password: info.password ?? '' };
  } catch (err) {
    if (__DEV__) console.warn('[LocalHotspot] start failed:', err?.message ?? err);
    return null;
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
