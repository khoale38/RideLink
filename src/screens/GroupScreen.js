import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import { HOTSPOT_PREFIX } from '../services/HotspotManager';
import { WifiQrCode } from '../components/WifiQrCode';

// Suggest a hotspot SSID derived from the rider's name so guests have something
// concrete to look for. The scanner matches anything starting with `RideLink-`.
function suggestSSID(name) {
  const slug = (name || 'rider').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  return `${HOTSPOT_PREFIX}${slug || 'rider'}`;
}

// Empirically, mesh audio holds up to ~5 riders on phone hotspots before CPU
// and bandwidth start to bite. Past this we warn the host; we don't hard-cap
// because the right number depends on hardware and signal. Hysteresis below
// (warn at 6, clear at 4) prevents the orange banner from flickering on/off
// as a peer briefly bounces around the boundary.
const MESH_SOFT_LIMIT_ON = 6;  // riders count (inclusive) that arms the warning
const MESH_SOFT_LIMIT_OFF = 4; // riders count at which the warning clears
const MESH_SOFT_LIMIT = MESH_SOFT_LIMIT_OFF + 1; // for display text only

const STATE_LABEL = {
  connecting: 'connecting…',
  connected: 'connected',
  failed: 'lost',
};
const STATE_COLOR = {
  connecting: '#f5a623',
  connected: '#4caf50',
  failed: '#c0392b',
};

// Memoized row so a peer whose `speaking` / `connectionState` didn't change
// skips re-render when the speaking-poll updates a sibling. Without this,
// the FlatList rebuilds every row on every ~300ms tick — wasteful at 5+
// riders, and the rebuild kills the gentle border animation.
const RiderRow = React.memo(function RiderRow({ item }) {
  const state = item.connectionState;
  const label = !item.isMe && state ? STATE_LABEL[state] : null;
  const color = !item.isMe && state ? STATE_COLOR[state] : null;
  return (
    <View style={[styles.riderRow, item.speaking && styles.riderRowSpeaking]}>
      <View style={[styles.avatar, item.speaking && styles.avatarSpeaking]}>
        <Text style={styles.avatarText}>{item.name?.[0]?.toUpperCase()}</Text>
      </View>
      <View style={styles.riderInfo}>
        <Text style={styles.riderName}>{item.name}</Text>
        {label && (
          <Text style={[styles.riderStatus, { color }]}>{label}</Text>
        )}
      </View>
    </View>
  );
});

function RiderList({ myName, peers, isSpeaking }) {
  // No useMemo on `data`: every poll tick changes `peers` (groupStore
  // returns a fresh array on speaking updates), so the deps would always
  // miss anyway. The real per-tick perf win is `React.memo(RiderRow)`
  // which skips rows whose item shape is unchanged. FlatList's data ref
  // changing each tick is fine — it walks keyExtractor + per-row memo.
  const data = [
    { id: 'me', name: `${myName} (you)`, speaking: isSpeaking, isMe: true },
    ...peers,
  ];
  const renderItem = useCallback(({ item }) => <RiderRow item={item} />, []);
  const keyExtractor = useCallback((item) => item.id, []);
  return (
    <FlatList
      data={data}
      keyExtractor={keyExtractor}
      style={styles.list}
      renderItem={renderItem}
    />
  );
}

export function GroupScreen({ store, vox, voxEnabled, onToggleVox, onMuteToggle, onLeave }) {
  const { myName, peers, muted, role, connected, hotspotPassword, hotspotSsid } = store;
  // VOX runs whenever we're in a group (see App.tsx), so vox.speaking is the
  // single source of truth for the local "you are talking" border — works
  // even when VOX-as-gate is off.
  const isSpeaking = !muted && vox.speaking;
  // On Android the LocalOnlyHotspot module hands us the real OS-generated SSID
  // via `hotspotSsid`. Elsewhere we fall back to a name-based suggestion that
  // the user must match manually in Settings.
  const activeSSID = hotspotSsid || suggestSSID(myName);
  const activePassword = hotspotPassword || '';
  // Only render the QR / password when we hold real OS-provided credentials.
  // On iOS (and Android when LocalOnlyHotspot fails) we'd otherwise show a
  // WPA QR for a guessed SSID with an empty password — scanning it can never
  // join the actual hotspot.
  const hasRealCreds = !!(hotspotSsid && hotspotPassword);

  // Latching state for the mesh-size warning. Arm at >=6, clear at <=4 so
  // a flapping peer at the boundary doesn't toggle the orange banner every
  // few seconds. The two thresholds are far enough apart to absorb churn
  // without hiding a real overload condition.
  const riderCount = peers.length + 1;
  // Lazy initializer: if the screen mounts already past the soft limit
  // (deep-link, hot reload, fast join), the banner shows on the very first
  // frame instead of waiting one tick for the effect below to flip it on.
  const [meshWarn, setMeshWarn] = useState(() => riderCount >= MESH_SOFT_LIMIT_ON);
  useEffect(() => {
    if (riderCount >= MESH_SOFT_LIMIT_ON) setMeshWarn(true);
    else if (riderCount <= MESH_SOFT_LIMIT_OFF) setMeshWarn(false);
  }, [riderCount]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>

      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.badge, connected ? styles.badgeOn : styles.badgeOff]}>
          <Text style={styles.badgeText}>{connected ? 'LIVE' : 'Connecting…'}</Text>
        </View>
      </View>

      {/* Hotspot info (host only) */}
      {role === 'host' && (
        <View style={styles.hotspotInfo}>
          <View style={styles.hotspotRow}>
            <View style={styles.hotspotText}>
              <Text style={styles.hotspotLabel}>Hotspot name</Text>
              <Text style={styles.hotspotValue}>{activeSSID}</Text>
              {hasRealCreds && (
                <>
                  <Text style={[styles.hotspotLabel, styles.hotspotLabelSpaced]}>Password</Text>
                  <Text style={styles.hotspotValue}>{activePassword}</Text>
                </>
              )}
              <Text style={styles.iosNote}>
                {Platform.OS === 'ios'
                  ? 'iOS: Settings → Personal Hotspot — turn it on (rename your device to match if needed). Riders get the password from you.'
                  : hasRealCreds
                    ? 'Hotspot started automatically. Guests scan the QR to join.'
                    : 'Android: Settings → Network → Hotspot — use the SSID above and share your hotspot password with riders.'}
              </Text>
            </View>
            {hasRealCreds && (
              <View style={styles.qrWrapper}>
                <WifiQrCode
                  ssid={activeSSID}
                  password={activePassword}
                  size={130}
                />
                <Text style={styles.qrCaption}>Scan to join WiFi</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Rider list */}
      <Text style={styles.sectionLabel}>RIDERS ({riderCount})</Text>
      {meshWarn && (
        <Text style={styles.meshWarning}>
          Audio may degrade above {MESH_SOFT_LIMIT} riders — WebRTC mesh scales O(N²).
        </Text>
      )}
      <RiderList myName={myName} peers={peers} isSpeaking={isSpeaking} />

      {/* VOX settings */}
      <View style={styles.voxSettings}>
        <View style={styles.voxRow}>
          <Text style={styles.settingLabel}>VOX (auto-transmit)</Text>
          <Switch
            value={voxEnabled}
            onValueChange={onToggleVox}
            trackColor={{ true: '#f5a623' }}
            thumbColor="#fff"
            accessibilityLabel="Voice-activated transmit toggle"
            accessibilityRole="switch"
          />
        </View>
        {voxEnabled && (
          <View style={styles.sliderRow}>
            <View style={styles.sliderHeader}>
              <Text style={styles.settingLabel}>
                Sensitivity: <Text style={styles.dbValue}>
                  {Math.round(vox.thresholdDb)} dB
                </Text>
              </Text>
              <TouchableOpacity
                style={[styles.recalBtn, vox.calibrating && styles.recalBtnActive]}
                onPress={vox.recalibrate}
                disabled={vox.calibrating}
                accessibilityRole="button"
                accessibilityLabel={vox.calibrating ? 'Calibrating voice activation' : 'Auto-calibrate voice activation'}
              >
                <Text style={styles.recalBtnText}>
                  {vox.calibrating ? 'Listening…' : 'Auto-calibrate'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.sliderHint}>
              {vox.calibrating
                ? 'Stay quiet for 2s — sampling noise floor…'
                : !vox.levelAvailable
                  ? 'Waiting for audio levels — mic stays open until a rider connects.'
                  : '◀ less · more ▶'}
            </Text>
            <Slider
              style={styles.slider}
              minimumValue={-60}
              maximumValue={-20}
              step={1}
              value={vox.thresholdDb}
              onValueChange={vox.setThresholdDb}
              minimumTrackTintColor="#f5a623"
              maximumTrackTintColor="#333"
              thumbTintColor="#f5a623"
              disabled={vox.calibrating}
              accessibilityLabel="Voice activation sensitivity"
              accessibilityValue={{ min: -60, max: -20, now: Math.round(vox.thresholdDb), text: `${Math.round(vox.thresholdDb)} decibels` }}
            />
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, muted && styles.controlBtnMuted]}
          onPress={onMuteToggle}
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
          accessibilityState={{ checked: muted }}
        >
          <Text style={styles.controlIcon}>{muted ? '🔇' : '🎙️'}</Text>
          <Text style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlBtn, styles.controlBtnLeave]}
          onPress={onLeave}
          accessibilityRole="button"
          accessibilityLabel="Leave the group ride"
        >
          <Text style={styles.controlIcon}>📵</Text>
          <Text style={styles.controlLabel}>Leave</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d', padding: 20 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeOn: { backgroundColor: '#1a4a1a' },
  badgeOff: { backgroundColor: '#3a2a00' },
  badgeText: { color: '#4caf50', fontWeight: '700', fontSize: 12 },

  hotspotInfo: {
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14,
    marginBottom: 14, borderLeftWidth: 3, borderLeftColor: '#f5a623',
  },
  hotspotRow: { flexDirection: 'row', alignItems: 'flex-start' },
  hotspotText: { flex: 1, paddingRight: 10 },
  hotspotLabel: { color: '#888', fontSize: 12 },
  hotspotLabelSpaced: { marginTop: 6 },
  hotspotValue: { color: '#fff', fontWeight: '700', fontSize: 14 },
  iosNote: { color: '#f5a623', fontSize: 11, marginTop: 6 },
  qrWrapper: { alignItems: 'center' },
  qrCaption: { color: '#aaa', fontSize: 10, marginTop: 4, fontWeight: '600' },

  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 1 },
  meshWarning: { color: '#f5a623', fontSize: 11, marginBottom: 6 },
  list: { flex: 1 },
  riderRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 10, marginBottom: 6,
    borderRadius: 10, borderWidth: 2, borderColor: 'transparent',
    backgroundColor: '#141414',
  },
  riderRowSpeaking: { borderColor: '#4caf50', backgroundColor: '#0d2010' },
  avatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center',
    marginRight: 14, borderWidth: 2, borderColor: '#333',
  },
  avatarSpeaking: { borderColor: '#4caf50' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 18 },
  riderInfo: { flex: 1 },
  riderName: { color: '#fff', fontSize: 16 },
  riderStatus: { fontSize: 11, marginTop: 2, fontWeight: '600' },
  voxSettings: {
    backgroundColor: '#1a1a1a', borderRadius: 12,
    padding: 14, marginTop: 12, marginBottom: 8,
  },
  voxRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderRow: { marginTop: 10 },
  sliderHeader: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 4,
  },
  recalBtn: {
    borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10,
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#555',
  },
  recalBtnActive: { borderColor: '#f5a623' },
  recalBtnText: { color: '#ccc', fontSize: 12, fontWeight: '600' },
  settingLabel: { color: '#aaa', fontSize: 13 },
  dbValue: { color: '#f5a623', fontWeight: '700' },
  sliderHint: { color: '#555', fontSize: 10, textAlign: 'right', marginBottom: 2 },
  slider: { width: '100%', height: 36 },

  controls: { flexDirection: 'row', gap: 12, marginTop: 4 },
  controlBtn: {
    flex: 1, backgroundColor: '#1a1a1a', borderRadius: 14,
    padding: 18, alignItems: 'center', borderWidth: 1, borderColor: '#333',
  },
  controlBtnMuted: { borderColor: '#f5a623' },
  controlBtnLeave: { borderColor: '#c0392b', flex: 0.5 },
  controlIcon: { fontSize: 28 },
  controlLabel: { color: '#aaa', fontSize: 12, marginTop: 4 },
});
