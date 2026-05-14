import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DeviceInfo from 'react-native-device-info';
import {
  HOTSPOT_PASSWORD,
  checkMicPermission,
  requestMicPermission,
} from '../services/HotspotManager';
import {
  checkNotificationPermission,
  requestNotificationPermission,
} from '../services/IntercomService';

// "Khoa's iPhone" → "Khoa". If the OS only gives back a generic model like
// "iPhone" (iOS 16+ privacy default), we leave it for the caller to substitute.
function riderNameFromDevice(deviceName) {
  if (!deviceName) return '';
  const trimmed = deviceName.trim();
  const apostropheIdx = trimmed.search(/['’]s\s/i);
  if (apostropheIdx > 0) return trimmed.slice(0, apostropheIdx);
  return trimmed;
}

// Anything that's just a bare model isn't a useful rider name.
const GENERIC_NAMES = new Set(['iphone', 'ipad', 'ipod', 'simulator', '']);

export function HomeScreen({ onHost, onJoin, busy = false }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState(HOTSPOT_PASSWORD);
  const [micGranted, setMicGranted] = useState(true); // optimistic — hides card until check completes
  const [micAsked, setMicAsked] = useState(false);    // becomes true after the user has tapped Allow at least once
  const [requestingMic, setRequestingMic] = useState(false);
  const [notifGranted, setNotifGranted] = useState(true);
  const [notifAsked, setNotifAsked] = useState(false);
  const [requestingNotif, setRequestingNotif] = useState(false);

  // Refresh permission status on mount and whenever the user returns from
  // Settings (no AppState wiring — a simple effect re-check on focus would
  // need navigation; for this screen, the check on mount + after the user
  // taps the button is enough).
  useEffect(() => {
    let cancelled = false;
    checkMicPermission().then((ok) => { if (!cancelled) setMicGranted(ok); });
    checkNotificationPermission().then((ok) => { if (!cancelled) setNotifGranted(ok); });
    return () => { cancelled = true; };
  }, []);

  const handleEnableNotif = async () => {
    if (requestingNotif) return;
    setRequestingNotif(true);
    try {
      const ok = await requestNotificationPermission();
      setNotifGranted(ok);
      if (!ok && notifAsked) {
        Linking.openSettings().catch(() => { /* ignore */ });
      }
      setNotifAsked(true);
    } finally {
      setRequestingNotif(false);
    }
  };

  const handleEnableMic = async () => {
    if (requestingMic) return;
    setRequestingMic(true);
    try {
      const ok = await requestMicPermission();
      setMicGranted(ok);
      if (!ok && micAsked) {
        // User has been asked before and is still denied — the OS won't show
        // the prompt again. Send them to Settings to flip it on.
        Linking.openSettings().catch(() => { /* ignore */ });
      }
      setMicAsked(true);
    } finally {
      setRequestingMic(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let suggestion = '';
      try {
        const raw = await DeviceInfo.getDeviceName();
        if (__DEV__) console.log('[HomeScreen] device name:', JSON.stringify(raw));
        suggestion = riderNameFromDevice(raw);
        if (GENERIC_NAMES.has(suggestion.toLowerCase())) suggestion = '';
      } catch (err) {
        if (__DEV__) console.warn('[HomeScreen] getDeviceName failed:', err);
      }

      // Fallback: use the device model if the user-assigned name was unavailable.
      if (!suggestion) {
        try {
          suggestion = DeviceInfo.getModel?.() || '';
          if (__DEV__) console.log('[HomeScreen] model fallback:', suggestion);
        } catch (_) { /* ignore */ }
      }

      if (cancelled) return;
      setName((current) => (current ? current : suggestion));
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
      <Text style={styles.logo}>RideLink</Text>
      <Text style={styles.sub}>Offline motorcycle intercom</Text>

      {!micGranted && (
        <View style={styles.micCard}>
          <Text style={styles.micTitle}>Microphone access needed</Text>
          <Text style={styles.micBody}>
            RideLink needs your mic for voice chat. {micAsked ? 'Open Settings to allow it.' : 'Tap Allow to grant access.'}
          </Text>
          <TouchableOpacity
            style={[styles.micBtn, requestingMic && styles.btnDisabled]}
            disabled={requestingMic}
            onPress={handleEnableMic}
          >
            <Text style={styles.micBtnText}>
              {requestingMic ? 'Requesting…' : micAsked ? 'Open Settings' : 'Allow microphone'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {!notifGranted && (
        <View style={styles.micCard}>
          <Text style={styles.micTitle}>Notification access needed</Text>
          <Text style={styles.micBody}>
            Android needs to show an ongoing notification so the intercom keeps
            running when your screen is off. {notifAsked ? 'Open Settings to allow it.' : 'Tap Allow to grant access.'}
          </Text>
          <TouchableOpacity
            style={[styles.micBtn, requestingNotif && styles.btnDisabled]}
            disabled={requestingNotif}
            onPress={handleEnableNotif}
          >
            <Text style={styles.micBtnText}>
              {requestingNotif ? 'Requesting…' : notifAsked ? 'Open Settings' : 'Allow notifications'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <TextInput
        style={styles.input}
        placeholder="Your rider name"
        placeholderTextColor="#666"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
      />

      <TextInput
        style={styles.input}
        placeholder="Hotspot password (≥8 chars)"
        placeholderTextColor="#666"
        value={password}
        onChangeText={setPassword}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <TouchableOpacity
        style={[styles.btn, styles.btnHost, busy && styles.btnDisabled]}
        disabled={busy || password.length < 8 || !micGranted || !notifGranted}
        onPress={() => name.trim() && password.length >= 8 && onHost(name.trim(), password)}
      >
        <Text style={styles.btnText}>
          {busy ? 'Starting…' : 'Create Group (Host)'}
        </Text>
        <Text style={styles.btnSub}>
          {Platform.OS === 'android'
            ? 'Turns on WiFi hotspot'
            : 'Enable hotspot manually, then tap'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.btn, styles.btnJoin, busy && styles.btnDisabled]}
        disabled={busy || password.length < 8 || !micGranted || !notifGranted}
        onPress={() => name.trim() && password.length >= 8 && onJoin(name.trim(), password)}
      >
        <Text style={styles.btnText}>{busy ? 'Joining…' : 'Join Group'}</Text>
        <Text style={styles.btnSub}>Scans for RideLink hotspot</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#0d0d0d',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  logo: { fontSize: 42, fontWeight: '800', color: '#f5a623', letterSpacing: 2 },
  sub: { color: '#888', marginBottom: 40, fontSize: 14 },
  input: {
    width: '100%', borderWidth: 1, borderColor: '#333',
    borderRadius: 12, padding: 16, color: '#fff',
    fontSize: 18, marginBottom: 24, backgroundColor: '#1a1a1a',
  },
  btn: {
    width: '100%', borderRadius: 14, padding: 18,
    alignItems: 'center', marginBottom: 16,
  },
  btnDisabled: { opacity: 0.5 },
  btnHost: { backgroundColor: '#f5a623' },
  btnJoin: { backgroundColor: '#1e3a5f', borderWidth: 1, borderColor: '#2a5a9f' },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  btnSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 },
  micCard: {
    width: '100%', backgroundColor: '#2a1a00', borderRadius: 12,
    padding: 14, marginBottom: 18, borderWidth: 1, borderColor: '#f5a623',
  },
  micTitle: { color: '#f5a623', fontWeight: '700', fontSize: 14, marginBottom: 4 },
  micBody: { color: '#ddd', fontSize: 12, marginBottom: 10 },
  micBtn: {
    backgroundColor: '#f5a623', borderRadius: 8, paddingVertical: 10,
    alignItems: 'center',
  },
  micBtnText: { color: '#0d0d0d', fontWeight: '700', fontSize: 14 },
});
