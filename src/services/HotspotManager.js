/**
 * WiFi hotspot helpers.
 * Android: can scan SSIDs with react-native-wifi-reborn (needs ACCESS_FINE_LOCATION).
 * iOS: cannot programmatically create/scan hotspots — user does it manually.
 */
import { Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';
import TcpSocket from 'react-native-tcp-socket';

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

// Live gateway detection: hotspots in the wild don't always use the stock
// 192.168.43.x / 172.20.10.x subnets — some OEMs change it (192.168.137.x,
// 192.168.49.x), and tethering apps pick their own. When we're connected,
// derive the gateway from our own IP by replacing the last octet with .1,
// which matches every Android/iOS hotspot subnet we've seen. Falls back to
// the hardcoded constant if the lookup fails or returns nothing usable.
export async function resolveGatewayIP() {
  return (await resolveGatewayIPVerbose()).gateway;
}

// Verbose variant for callers that want to know whether the gateway was
// derived from a live WiFi IP or fell back to the hardcoded default — useful
// for surfacing a clearer "you don't look connected to a hotspot" error in
// the join flow (10.x.x.x corporate WiFi, no WiFi at all, etc.) instead of
// trying 192.168.43.1 and timing out.
export async function resolveGatewayIPVerbose() {
  try {
    const ip = await WifiManager.getIP();
    if (typeof ip === 'string') {
      const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
      if (m) return { gateway: `${m[1]}.1`, source: 'wifi', wifiIp: ip };
    }
    return { gateway: getGatewayIP(), source: 'fallback', wifiIp: ip ?? null };
  } catch (err) {
    return { gateway: getGatewayIP(), source: 'error', error: err };
  }
}

// Recommended polling cadence for `isIOSHotspotActive` on the Home screen.
// Each call spins up a throw-away TCP listener and waits up to 1.5s for the
// bind result — at 3s intervals the home screen was hammering the socket
// layer. 8s is a usability-vs-cost compromise: a user toggling Personal
// Hotspot in Settings will see the banner update within ~8s.
export const IOS_HOTSPOT_POLL_MS = 8000;

// iOS doesn't expose a Personal Hotspot API. We probe instead: when the
// hotspot is active, iOS creates a bridge100 interface with the host IP
// 172.20.10.1. Try to bind a throw-away TCP listener to that address — bind
// succeeds only if the IP exists locally, which means the hotspot is on.
// Returns true/false on iOS, and null on Android (no detection needed — we
// turn the hotspot on programmatically anyway).
export async function isIOSHotspotActive() {
  if (Platform.OS !== 'ios') return null;
  return new Promise((resolve) => {
    let settled = false;
    let server = null;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { server?.close(); } catch (_) { /* ignore */ }
      resolve(result);
    };
    try {
      server = TcpSocket.createServer(() => { /* unused */ });
      server.on('error', () => done(false));
      server.listen({ port: 0, host: '172.20.10.1' }, () => done(true));
    } catch {
      done(false);
    }
    timer = setTimeout(() => done(false), 1500);
  });
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
