import React from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  Platform, Switch, Slider,
} from 'react-native';
import { HOTSPOT_PREFIX, HOTSPOT_PASSWORD } from '../services/HotspotManager';

export function GroupScreen({ store, vox, voxEnabled, onToggleVox, onMuteToggle, onLeave }) {
  const { myName, peers, muted, role, connected } = store;
  const isSpeaking = voxEnabled && vox.speaking;

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>RideLink</Text>
        <View style={[styles.badge, connected ? styles.badgeOn : styles.badgeOff]}>
          <Text style={styles.badgeText}>{connected ? 'LIVE' : 'Connecting…'}</Text>
        </View>
      </View>

      {/* Hotspot info (host only) */}
      {role === 'host' && (
        <View style={styles.hotspotInfo}>
          <Text style={styles.hotspotLabel}>Hotspot name</Text>
          <Text style={styles.hotspotValue}>{HOTSPOT_PREFIX}your-phone</Text>
          <Text style={styles.hotspotLabel}>
            Password: <Text style={styles.hotspotValue}>{HOTSPOT_PASSWORD}</Text>
          </Text>
          {Platform.OS === 'ios' && (
            <Text style={styles.iosNote}>
              Enable Personal Hotspot in Settings, then share this name with your group.
            </Text>
          )}
        </View>
      )}

      {/* VOX indicator */}
      <View style={[styles.voxIndicator, isSpeaking && styles.voxIndicatorActive]}>
        <View style={[styles.voxDot, isSpeaking && styles.voxDotActive]} />
        <Text style={[styles.voxLabel, isSpeaking && styles.voxLabelActive]}>
          {muted ? 'MUTED' : voxEnabled ? (isSpeaking ? 'TRANSMITTING' : 'LISTENING…') : 'VOX OFF'}
        </Text>
      </View>

      {/* Rider list */}
      <Text style={styles.sectionLabel}>RIDERS ({peers.length + 1})</Text>
      <FlatList
        data={[{ id: 'me', name: `${myName} (you)`, speaking: isSpeaking }, ...peers]}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item }) => (
          <View style={styles.riderRow}>
            <View style={[styles.avatar, item.speaking && styles.avatarSpeaking]}>
              <Text style={styles.avatarText}>{item.name?.[0]?.toUpperCase()}</Text>
            </View>
            <Text style={styles.riderName}>{item.name}</Text>
            {item.speaking && <Text style={styles.speakingBadge}>speaking</Text>}
          </View>
        )}
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
    </View>
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
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  avatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center',
    marginRight: 14, borderWidth: 2, borderColor: '#333',
  },
  avatarSpeaking: { borderColor: '#4caf50' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 18 },
  riderName: { color: '#fff', fontSize: 16, flex: 1 },
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
