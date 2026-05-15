import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DeviceInfo from 'react-native-device-info';
import { requestMicPermission } from '../services/HotspotManager';
import {
  checkNotificationPermission,
  requestNotificationPermission,
} from '../services/IntercomService';
import { Recorder } from '../services/AudioRecorder';

const MIC_TEST_DURATION_MS = 4000;

// Parse raw base64 PCM-16 → RMS in dBFS (mirrors useVOX logic)
function rmsDb(base64) {
  try {
    // eslint-disable-next-line no-undef
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const samples = new Int16Array(bytes.buffer);
    if (samples.length === 0) return -Infinity;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const norm = samples[i] / 32768;
      sum += norm * norm;
    }
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  } catch {
    return -Infinity;
  }
}

// dBFS (-60..0) → 0..1 fill ratio
function dbToFill(db) {
  if (!isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

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
  const [password, setPassword] = useState('');
  const [micGranted, setMicGranted] = useState(true); // optimistic — hides card until check completes
  const [micAsked, setMicAsked] = useState(false);    // becomes true after the user has tapped Allow at least once
  const [requestingMic, setRequestingMic] = useState(false);
  const [notifGranted, setNotifGranted] = useState(true);
  const [notifAsked, setNotifAsked] = useState(false);
  const [requestingNotif, setRequestingNotif] = useState(false);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(null); // null = idle, number = dBFS
  const micTestTimer = useRef(null);

  // Auto-request permissions on mount. If already granted the OS returns
  // immediately with no dialog. Only shows a card if the user previously
  // denied and the OS won't prompt again (they need to go to Settings).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const micOk = await requestMicPermission();
      if (!cancelled) {
        setMicGranted(micOk);
        if (!micOk) setMicAsked(true); // already prompted, next tap → Settings
      }
    })();
    (async () => {
      const notifOk = await requestNotificationPermission();
      if (!cancelled) {
        setNotifGranted(notifOk);
        if (!notifOk) setNotifAsked(true);
      }
    })();
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

  const stopMicTest = () => {
    clearTimeout(micTestTimer.current);
    Recorder.setListener(null);
    Recorder.stop();
    setMicTesting(false);
  };

  const handleMicTest = async () => {
    if (micTesting) { stopMicTest(); setMicLevel(null); return; }

    if (Platform.OS === 'ios') {
      // iOS can't run RNAudioRecord alongside WebRTC; just confirm mic works
      setMicTesting(true);
      try {
        const { mediaDevices } = await import('react-native-webrtc');
        const stream = await mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } });
        setMicLevel(0); // signal success
      } catch {
        setMicLevel(-Infinity);
      }
      setMicTesting(false);
      return;
    }

    setMicTesting(true);
    setMicLevel(-Infinity);
    try {
      Recorder.configure({ sampleRate: 8000, channels: 1, bitsPerSample: 16, wavFile: '' });
      Recorder.setListener((raw) => {
        const db = rmsDb(raw);
        setMicLevel(db);
      });
      Recorder.start();
    } catch (err) {
      if (__DEV__) console.warn('[MicTest] failed to start:', err);
      setMicTesting(false);
      return;
    }
    micTestTimer.current = setTimeout(() => { stopMicTest(); }, MIC_TEST_DURATION_MS);
  };

  // Clean up mic test if screen unmounts
  useEffect(() => () => { clearTimeout(micTestTimer.current); Recorder.setListener(null); Recorder.stop(); }, []);

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

      {micGranted && (
        <View style={styles.micTestRow}>
          <TouchableOpacity
            style={[styles.micTestBtn, micTesting && styles.micTestBtnActive, busy && styles.btnDisabled]}
            disabled={busy}
            onPress={handleMicTest}
          >
            <Text style={styles.micTestBtnText}>
              {micTesting ? 'Stop test' : 'Test mic'}
            </Text>
          </TouchableOpacity>
          {micTesting && (
            <View style={styles.levelBarBg}>
              <View style={[styles.levelBarFill, { width: `${dbToFill(micLevel) * 100}%` }]} />
            </View>
          )}
          {!micTesting && micLevel !== null && (
            <Text style={styles.micLevelText}>
              {isFinite(micLevel) ? `${micLevel.toFixed(0)} dBFS — mic OK` : 'No signal detected'}
            </Text>
          )}
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
  micTestRow: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    marginBottom: 18, gap: 12,
  },
  micTestBtn: {
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16,
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#555',
  },
  micTestBtnActive: { borderColor: '#f5a623' },
  micTestBtnText: { color: '#ccc', fontSize: 13, fontWeight: '600' },
  levelBarBg: {
    flex: 1, height: 10, backgroundColor: '#222',
    borderRadius: 5, overflow: 'hidden',
  },
  levelBarFill: {
    height: '100%', backgroundColor: '#f5a623', borderRadius: 5,
  },
  micLevelText: { color: '#888', fontSize: 12, flexShrink: 1 },
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
