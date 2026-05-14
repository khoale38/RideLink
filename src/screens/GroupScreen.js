import React from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import { HOTSPOT_PREFIX, HOTSPOT_PASSWORD } from '../services/HotspotManager';

// Suggest a hotspot SSID derived from the rider's name so guests have something
// concrete to look for. The scanner matches anything starting with `RideLink-`.
function suggestSSID(name) {
  const slug = (name || 'rider').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  return `${HOTSPOT_PREFIX}${slug || 'rider'}`;
}

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

export function GroupScreen({ store, vox, voxEnabled, onToggleVox, onMuteToggle, onLeave }) {
  const { myName, peers, muted, role, connected } = store;
  const isSpeaking = voxEnabled && vox.speaking;
  const suggestedSSID = suggestSSID(myName);

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
          <Text style={styles.hotspotLabel}>Set your hotspot name to</Text>
          <Text style={styles.hotspotValue}>{suggestedSSID}</Text>
          <Text style={styles.hotspotLabel}>
            Password: <Text style={styles.hotspotValue}>{HOTSPOT_PASSWORD}</Text>
          </Text>
          <Text style={styles.iosNote}>
            {Platform.OS === 'ios'
              ? 'Settings → General → About → Name, set to the value above, then turn on Personal Hotspot.'
              : 'Settings → Network & Internet → Hotspot — set the SSID to the value above and password as listed.'}
          </Text>
        </View>
      )}

      {/* Rider list */}
      <Text style={styles.sectionLabel}>RIDERS ({peers.length + 1})</Text>
      <FlatList
        data={[
          { id: 'me', name: `${myName} (you)`, speaking: isSpeaking, isMe: true },
          ...peers,
        ]}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item }) => {
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
        }}
      />

      {/* VOX settings */}
      <View style={styles.voxSettings}>
        <View style={styles.voxRow}>
          <Text style={styles.settingLabel}>VOX (auto-transmit)</Text>
          <Switch
            value={voxEnabled}
            onValueChange={onToggleVox}
            trackColor={{ true: '#f5a623' }}
            thumbColor="#fff"
          />
        </View>
        {voxEnabled && (
          <View style={styles.sliderRow}>
            <Text style={styles.settingLabel}>
              Sensitivity: <Text style={styles.dbValue}>{vox.thresholdDb} dB</Text>
            </Text>
            <Text style={styles.sliderHint}>◀ less · more ▶</Text>
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
            />
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, muted && styles.controlBtnMuted]}
          onPress={onMuteToggle}
        >
          <Text style={styles.controlIcon}>{muted ? '🔇' : '🎙️'}</Text>
          <Text style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.controlBtn, styles.controlBtnLeave]} onPress={onLeave}>
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
  logo: { fontSize: 28, fontWeight: '800', color: '#f5a623' },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeOn: { backgroundColor: '#1a4a1a' },
  badgeOff: { backgroundColor: '#3a2a00' },
  badgeText: { color: '#4caf50', fontWeight: '700', fontSize: 12 },

  hotspotInfo: {
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14,
    marginBottom: 14, borderLeftWidth: 3, borderLeftColor: '#f5a623',
  },
  hotspotLabel: { color: '#888', fontSize: 12 },
  hotspotValue: { color: '#fff', fontWeight: '700', fontSize: 14 },
  iosNote: { color: '#f5a623', fontSize: 11, marginTop: 6 },

  voxIndicator: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1a1a1a', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    marginBottom: 16, borderWidth: 1, borderColor: '#2a2a2a',
  },
  voxIndicatorActive: { borderColor: '#4caf50', backgroundColor: '#0d2010' },
  voxDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#555', marginRight: 10 },
  voxDotActive: { backgroundColor: '#4caf50' },
  voxLabel: { color: '#666', fontSize: 13, fontWeight: '600', letterSpacing: 1 },
  voxLabelActive: { color: '#4caf50' },

  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 1 },
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
  speakingBadge: {
    color: '#4caf50', fontSize: 11, fontWeight: '700',
    backgroundColor: '#0d2010', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
  },

  voxSettings: {
    backgroundColor: '#1a1a1a', borderRadius: 12,
    padding: 14, marginTop: 12, marginBottom: 8,
  },
  voxRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sliderRow: { marginTop: 10 },
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
