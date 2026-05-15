/**
 * WiFi hotspot helpers.
 * Android: can scan SSIDs with react-native-wifi-reborn (needs ACCESS_FINE_LOCATION).
 * iOS: cannot programmatically create/scan hotspots — user does it manually.
 */
import { Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

export const HOTSPOT_PREFIX = 'RideLink-';
export const SIGNALING_PORT = 8765;

// Default gateway IPs for phone-created hotspots
const GATEWAY = {
  android: '192.168.43.1',
  ios: '172.20.10.1',
};

export function getGatewayIP() {
  return GATEWAY[Platform.OS] ?? GATEWAY.android;
}

export async function requestLocationPermission() {
  if (Platform.OS !== 'android') return true;
  const { PermissionsAndroid } = await import('react-native');
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    {
      title: 'Location permission',
      message: 'RideLink needs location access to scan for nearby hotspots.',
      buttonPositive: 'Allow',
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// Best-effort silent check of mic permission status. We can't fully distinguish
// "undetermined" from "denied" on iOS without an extra dependency. On iOS we
// always re-probe via getUserMedia rather than caching at module scope — a
// user who revokes mic access in Settings would otherwise look "granted" to
// us until app restart.
export async function checkMicPermission() {
  if (Platform.OS === 'android') {
    const { PermissionsAndroid } = await import('react-native');
    return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  }
  // iOS: no cheap silent check available. Treat as unknown; let
  // requestMicPermission do the live probe.
  return false;
}

export async function requestMicPermission() {
  if (Platform.OS === 'android') {
    const { PermissionsAndroid } = await import('react-native');
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Microphone permission',
        message: 'RideLink needs your mic for voice chat.',
        buttonPositive: 'Allow',
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }
  // iOS: no programmatic permission API without an extra dep. Probe with
  // getUserMedia EVERY call — this catches a Settings-side revoke that
  // would otherwise leave us thinking we still had access until restart.
  // Release the stream immediately so we don't hold AVAudioSession before
  // WebRTC opens it.
  try {
    const { mediaDevices } = await import('react-native-webrtc');
    const stream = await mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } });
    return true;
  } catch {
    return false;
  }
}

export async function scanForRideLinkHotspot() {
  if (Platform.OS === 'ios') return null; // iOS can't scan SSIDs
  try {
    const networks = await WifiManager.loadWifiList();
    return networks.find((n) => n.SSID?.startsWith(HOTSPOT_PREFIX)) ?? null;
  } catch {
    return null;
  }
}

const CONNECT_TIMEOUT_MS = 20000;

export async function connectToHotspot(ssid, password) {
  if (Platform.OS === 'ios') return false;
  if (!password) {
    if (__DEV__) console.warn('[HotspotManager] connectToHotspot called without a password');
    return false;
  }
  // WifiManager.connectToProtectedSSID can hang indefinitely if WiFi state is
  // stuck (radio off, captive portal, etc.). Race it against a timeout so the
  // UI doesn't sit on "Joining…" forever.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('WiFi connect timed out')), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      WifiManager.connectToProtectedSSID(ssid, password, false, false),
      timeout,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
