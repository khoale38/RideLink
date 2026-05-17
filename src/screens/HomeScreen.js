import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Linking, Alert,
  Keyboard, TouchableWithoutFeedback, ScrollView, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DeviceInfo from 'react-native-device-info';
import InCallManager from 'react-native-incall-manager';
import { mediaDevices } from 'react-native-webrtc';
import { AppState } from 'react-native';
import { requestMicPermission, isIOSHotspotActive, IOS_HOTSPOT_POLL_MS } from '../services/HotspotManager';
import { buildLoopbackPair } from '../services/MicLoopback';
import {
  checkNotificationPermission,
  requestNotificationPermission,
} from '../services/IntercomService';

// audioLevel from getStats() is 0..1 (linear amplitude); map to 0..1 fill with
// a mild curve so quiet speech still moves the bar visibly.
function levelToFill(level) {
  if (!level || level <= 0) return 0;
  return Math.min(1, Math.sqrt(level) * 1.2);
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
  const [micLevel, setMicLevel] = useState(0); // 0..1 amplitude from getStats
  // null = unknown (Android, or first check pending); true/false = iOS Personal Hotspot state
  const [iosHotspotOn, setIosHotspotOn] = useState(null);
  const monitorStreamRef = useRef(null);
  const pcLocalRef = useRef(null);
  const pcRemoteRef = useRef(null);
  const statsTimerRef = useRef(null);

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

  // iOS only: poll Personal Hotspot state by probing 172.20.10.1. We re-check
  // periodically since the user may flip it while sitting on this screen.
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    let cancelled = false;
    let id = null;
    const check = async () => {
      const on = await isIOSHotspotActive();
      if (!cancelled) setIosHotspotOn(on);
    };
    const start = () => {
      if (id) return;
      check();
      id = setInterval(check, IOS_HOTSPOT_POLL_MS);
    };
    const stop = () => {
      if (id) { clearInterval(id); id = null; }
    };
    start();
    // Pause polling when the app is backgrounded — a probe every IOS_HOTSPOT
    // _POLL_MS that spins up a throw-away TCP listener does no good for a
    // user who can't see the UI.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      cancelled = true;
      stop();
      appStateSub?.remove?.();
    };
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
    try { InCallManager.setForceSpeakerphoneOn(false); } catch (_) { /* ignore */ }
    try { InCallManager.stop(); } catch (_) { /* ignore */ }
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    try { monitorStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
    try { pcLocalRef.current?.close(); } catch (_) { /* ignore */ }
    try { pcRemoteRef.current?.close(); } catch (_) { /* ignore */ }
    monitorStreamRef.current = null;
    pcLocalRef.current = null;
    pcRemoteRef.current = null;
    setMicTesting(false);
    setMicLevel(0);
  };

  // Discord-style live mic monitor: pipe the local mic through a loopback
  // RTCPeerConnection so the user hears themselves through the device speaker
  // until they toggle the test off. react-native-webrtc auto-plays remote
  // audio tracks, so no playback wiring is needed.
  const handleMicTest = async () => {
    if (micTesting) { stopMicTest(); return; }

    setMicTesting(true);
    setMicLevel(0);
    try {
      // Route playback through the loudspeaker instead of the earpiece.
      try {
        InCallManager.start({ media: 'audio' });
        InCallManager.setForceSpeakerphoneOn(true);
      } catch (_) { /* ignore — monitor still works, just quieter */ }
      const stream = await mediaDevices.getUserMedia({ audio: true });
      monitorStreamRef.current = stream;

      const { pcLocal, pcRemote } = await buildLoopbackPair(stream, { audible: true });
      pcLocalRef.current = pcLocal;
      pcRemoteRef.current = pcRemote;

      // Poll local media-source audioLevel for the meter — works on both
      // iOS and Android without a second mic consumer.
      statsTimerRef.current = setInterval(async () => {
        const pc = pcLocalRef.current;
        if (!pc) return;
        try {
          const stats = await pc.getStats();
          // Re-check after await: stopMicTest() may have nulled the ref (and
          // unmount may have set state to unsafe). Without this guard we'd
          // dispatch a setMicLevel against a torn-down test session.
          if (!pcLocalRef.current) return;
          let level = 0;
          stats.forEach((r) => {
            if (r.type === 'media-source' && typeof r.audioLevel === 'number') {
              if (r.audioLevel > level) level = r.audioLevel;
            }
          });
          setMicLevel(level);
        } catch (_) { /* ignore transient stats errors */ }
      }, 120);
    } catch (err) {
      if (__DEV__) console.warn('[MicTest] monitor failed:', err);
      stopMicTest();
    }
  };

  // Clean up mic monitor if screen unmounts
  useEffect(() => () => { stopMicTest(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Image
        source={require('../../assets/RideLink.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityLabel="RideLink"
      />
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
              {micTesting ? 'Stop mic test' : 'Test mic'}
            </Text>
          </TouchableOpacity>
          {micTesting ? (
            <View style={styles.levelBarBg}>
              <View style={[styles.levelBarFill, { width: `${levelToFill(micLevel) * 100}%` }]} />
            </View>
          ) : (
            <Text style={styles.micLevelText}>Hear yourself live</Text>
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

      {Platform.OS === 'android' && (
        <TextInput
          style={styles.input}
          placeholder="Host's hotspot password (Join only)"
          placeholderTextColor="#666"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      {Platform.OS === 'ios' && iosHotspotOn === false && (
        <Text style={styles.iosHint}>
          iOS host: enable Personal Hotspot in Settings first, then tap Create.
          Guests connect to your hotspot from their own WiFi settings.
        </Text>
      )}
      {Platform.OS === 'ios' && iosHotspotOn === true && (
        <Text style={styles.iosHintOk}>
          Personal Hotspot is on — guests can connect now.
        </Text>
      )}

      <TouchableOpacity
        style={[styles.btn, styles.btnHost, busy && styles.btnDisabled]}
        disabled={busy}
        onPress={() => {
          if (!name.trim()) {
            Alert.alert('Name required', 'Enter your rider name first.');
            return;
          }
          if (!micGranted) {
            Alert.alert('Microphone needed', 'Grant microphone access to host.');
            return;
          }
          if (!notifGranted) {
            Alert.alert(
              'Notifications needed',
              'Android needs notification permission to keep the intercom running with the screen off.',
            );
            return;
          }
          if (Platform.OS === 'ios' && iosHotspotOn !== true) {
            // iOS can't programmatically start Personal Hotspot. If we
            // couldn't detect it as on, ask the user to enable it.
            Alert.alert(
              'Enable Personal Hotspot first',
              'Go to Settings → Personal Hotspot, turn it on. Riders connect from their own WiFi settings. Then tap Continue.',
              [
                { text: 'Open Settings', onPress: () => Linking.openURL('App-Prefs:INTERNET_TETHERING').catch(() => Linking.openSettings()) },
                { text: 'Continue', onPress: () => onHost(name.trim()) },
                { text: 'Cancel', style: 'cancel' },
              ],
            );
          } else {
            onHost(name.trim());
          }
        }}
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
        disabled={busy}
        onPress={() => {
          if (!name.trim()) {
            Alert.alert('Name required', 'Enter your rider name first.');
            return;
          }
          if (!micGranted) {
            Alert.alert('Microphone needed', 'Grant microphone access to join.');
            return;
          }
          if (!notifGranted) {
            Alert.alert(
              'Notifications needed',
              'Android needs notification permission to keep the intercom running with the screen off.',
            );
            return;
          }
          if (Platform.OS === 'android' && password.length < 8) {
            Alert.alert(
              'Hotspot password required',
              "Enter the host's hotspot password (≥8 chars) so we can connect to their WiFi.",
            );
            return;
          }
          onJoin(name.trim(), password);
        }}
      >
        <Text style={styles.btnText}>{busy ? 'Joining…' : 'Join Group'}</Text>
        <Text style={styles.btnSub}>
          {Platform.OS === 'android'
            ? 'Scans for RideLink hotspot'
            : 'Connect to host hotspot in WiFi settings first'}
        </Text>
      </TouchableOpacity>
    </ScrollView>
    </TouchableWithoutFeedback>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0d0d0d' },
  container: {
    flexGrow: 1, backgroundColor: '#0d0d0d',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  logo: { width: 72, height: 72, marginBottom: 4, borderRadius: 16 },
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
  iosHint: {
    width: '100%', color: '#888', fontSize: 12, marginTop: -16,
    marginBottom: 20, lineHeight: 16,
  },
  iosHintOk: {
    width: '100%', color: '#4caf50', fontSize: 12, marginTop: -16,
    marginBottom: 20, lineHeight: 16,
  },
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
