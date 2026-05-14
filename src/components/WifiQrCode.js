import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import qrcode from 'qrcode-generator';

// Build a WIFI: URI that iOS Camera + Android Camera natively recognize.
// Per the de-facto standard, `;`, `,`, `:`, `"`, `\` must be backslash-escaped.
function escapeWifiField(s) {
  return String(s).replace(/([\\;,:"])/g, '\\$1');
}

export function buildWifiUri({ ssid, password, hidden = false }) {
  return `WIFI:T:WPA;S:${escapeWifiField(ssid)};P:${escapeWifiField(password)};H:${hidden ? 'true' : 'false'};;`;
}

/**
 * Renders a Wi-Fi QR code as a grid of <View> cells — no native deps required.
 * Scanning the code in iOS/Android Camera surfaces a "Join Network" action.
 *
 * Cell-per-View is fine at this size (~30 modules + quiet zone ≈ 1300 Views).
 * If we grow the payload past ~80 chars we'd want a Canvas/SVG renderer.
 */
export function WifiQrCode({ ssid, password, size = 180 }) {
  const matrix = useMemo(() => {
    const qr = qrcode(0, 'M'); // auto type, medium error correction
    qr.addData(buildWifiUri({ ssid, password }));
    qr.make();
    const count = qr.getModuleCount();
    const grid = [];
    for (let r = 0; r < count; r++) {
      const row = new Array(count);
      for (let c = 0; c < count; c++) row[c] = qr.isDark(r, c);
      grid.push(row);
    }
    return grid;
  }, [ssid, password]);

  const modules = matrix.length;
  const quiet = 2; // module-wide quiet zone on each side
  const total = modules + quiet * 2;
  const cell = Math.floor(size / total);
  const actualSize = cell * total;

  return (
    <View style={[styles.frame, { width: actualSize, height: actualSize, padding: cell * quiet }]}>
      {matrix.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((dark, c) => (
            <View
              key={c}
              style={{
                width: cell,
                height: cell,
                backgroundColor: dark ? '#000' : '#fff',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#fff', borderRadius: 6 },
  row: { flexDirection: 'row' },
});
