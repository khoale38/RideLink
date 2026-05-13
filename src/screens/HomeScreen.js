import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';

export function HomeScreen({ onHost, onJoin }) {
  const [name, setName] = useState('');

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>RideLink</Text>
      <Text style={styles.sub}>Offline motorcycle intercom</Text>

      <TextInput
        style={styles.input}
        placeholder="Your rider name"
        placeholderTextColor="#666"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
      />

      <TouchableOpacity
        style={[styles.btn, styles.btnHost]}
        onPress={() => name.trim() && onHost(name.trim())}
      >
        <Text style={styles.btnText}>Create Group (Host)</Text>
        <Text style={styles.btnSub}>
          {Platform.OS === 'android'
            ? 'Turns on WiFi hotspot'
            : 'Enable hotspot manually, then tap'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.btn, styles.btnJoin]}
        onPress={() => name.trim() && onJoin(name.trim())}
      >
        <Text style={styles.btnText}>Join Group</Text>
        <Text style={styles.btnSub}>Scans for RideLink hotspot</Text>
      </TouchableOpacity>
    </View>
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
  btnHost: { backgroundColor: '#f5a623' },
  btnJoin: { backgroundColor: '#1e3a5f', borderWidth: 1, borderColor: '#2a5a9f' },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  btnSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 },
});
