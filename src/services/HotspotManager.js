/**
 * WiFi hotspot helpers.
 * Android: can scan SSIDs with react-native-wifi-reborn (needs ACCESS_FINE_LOCATION).
 * iOS: cannot programmatically create/scan hotspots — user does it manually.
 */
import { Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

export const HOTSPOT_PREFIX = 'RideLink-';
export const HOTSPOT_PASSWORD = 'ridelink123';
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

export async function requestMicPermission() {
  if (Platform.OS !== 'android') return true;
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

export async function scanForRideLinkHotspot() {
  if (Platform.OS === 'ios') return null; // iOS can't scan SSIDs
  try {
    const networks = await WifiManager.loadWifiList();
    return networks.find((n) => n.SSID?.startsWith(HOTSPOT_PREFIX)) ?? null;
  } catch {
    return null;
  }
}

export async function connectToHotspot(ssid) {
  if (Platform.OS === 'ios') return false;
  try {
    await WifiManager.connectToProtectedSSID(ssid, HOTSPOT_PASSWORD, false, false);
    return true;
  } catch {
    return false;
  }
}
