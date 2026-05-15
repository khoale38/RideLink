/**
 * Embedded TCP signaling server — runs on the hotspot host phone.
 * Uses newline-delimited JSON over TCP (no Node.js needed).
 * Guests connect to tcp://192.168.43.1:8765 (Android) or 172.20.10.1:8765 (iOS)
 */
import TcpSocket from 'react-native-tcp-socket';

// Crypto-strong v4 UUID. Relies on the `react-native-get-random-values`
// polyfill imported in index.js so `crypto.getRandomValues` is available.
function uuidv4() {
  const bytes = new Uint8Array(16);
  // eslint-disable-next-line no-undef
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    // Polyfill missing — should not happen in production, but fall back so a
    // misconfigured test env doesn't crash. Logged loudly in dev.
    if (__DEV__) console.warn('[SignalingServer] crypto.getRandomValues unavailable; using Math.random fallback');
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const SIGNALING_PORT = 8765;
// Cap per-client receive buffer. Any single signaling message is well under
// 64KB (SDP + ICE candidates). An unterminated stream past this is treated
// as malicious / broken and the client is dropped.
const MAX_BUFFER_BYTES = 64 * 1024;

let server = null;
let sharedPassword = null;
const clients = new Map(); // clientId -> { socket, name, buffer, authed }

export function startSignalingServer(password, onEvent) {
  if (server) return;
  if (!password || typeof password !== 'string') {
    throw new Error('startSignalingServer requires a non-empty password');
  }
  sharedPassword = password;

  server = TcpSocket.createServer((socket) => {
    const clientId = uuidv4();
    clients.set(clientId, { socket, name: null, buffer: '', authed: false });

    socket.on('data', (raw) => {
      const entry = clients.get(clientId);
      if (!entry) return;

      entry.buffer += raw.toString();
      if (entry.buffer.length > MAX_BUFFER_BYTES) {
        if (__DEV__) console.warn('[SignalingServer] buffer overflow, dropping client', clientId);
        try { entry.socket.destroy(); } catch (_) { /* ignore */ }
        clients.delete(clientId);
        return;
      }
      const lines = entry.buffer.split('\n');
      entry.buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          if (__DEV__) console.warn('[SignalingServer] malformed message dropped');
          continue;
        }
        try {
          _handleMessage(clientId, msg, onEvent);
        } catch (err) {
          if (__DEV__) console.warn('[SignalingServer] handler threw:', err);
        }
      }
    });

    socket.on('close', () => {
      const entry = clients.get(clientId);
      if (entry) {
        _broadcast({ type: 'peer_left', id: clientId, name: entry.name }, clientId);
        if (!entry.isHost) {
          onEvent?.({ type: 'peer_left', id: clientId, name: entry.name });
        }
      }
      clients.delete(clientId);
    });

    socket.on('error', (err) => {
      if (__DEV__) console.warn('[SignalingServer] client socket error:', err?.message ?? err);
      const entry = clients.get(clientId);
      if (entry) {
        try { entry.socket.destroy(); } catch (_) { /* ignore */ }
      }
      clients.delete(clientId);
    });
  });

  server.on('error', (err) => {
    if (__DEV__) console.warn('[SignalingServer] server error:', err?.message ?? err);
    onEvent?.({ type: 'server_error', error: err });
  });

  server.listen({ port: SIGNALING_PORT, host: '0.0.0.0' }, () => {
    onEvent?.({ type: 'server_started', port: SIGNALING_PORT });
  });
}

export function stopSignalingServer() {
  if (!server) return;
  clients.forEach((entry) => {
    try { entry.socket.destroy(); } catch (_) { /* ignore */ }
  });
  clients.clear();
  try { server.close(); } catch (_) { /* ignore */ }
  server = null;
  sharedPassword = null;
}

function _handleMessage(clientId, msg, onEvent) {
  const entry = clients.get(clientId);
  if (!entry || !msg || typeof msg.type !== 'string') return;

  // Auth gate: every client must successfully `join` (which carries the shared
  // hotspot password) before the server will relay anything else. Anything
  // before auth other than `join` is treated as hostile and the socket is
  // dropped — this prevents a LAN attacker from injecting offers/ICE.
  if (!entry.authed && msg.type !== 'join') {
    if (__DEV__) console.warn('[SignalingServer] unauthenticated', msg.type, 'from', clientId);
    try { entry.socket.destroy(); } catch (_) { /* ignore */ }
    clients.delete(clientId);
    return;
  }

  switch (msg.type) {
    case 'join': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return;
      if (typeof msg.password !== 'string' || msg.password !== sharedPassword) {
        if (__DEV__) console.warn('[SignalingServer] auth failed for', clientId);
        try { entry.socket.destroy(); } catch (_) { /* ignore */ }
        clients.delete(clientId);
        return;
      }
      entry.authed = true;
      entry.name = msg.name;
      entry.isHost = !!msg.isHost;
      const peers = [];
      clients.forEach((c, id) => {
        if (id !== clientId && c.name) peers.push({ id, name: c.name });
      });
      _send(clientId, { type: 'peer_list', peers, yourId: clientId });
      _broadcast({ type: 'peer_joined', id: clientId, name: msg.name }, clientId);
      // Skip notifying the local listener about the host's own loopback
      // connection — the host already represents itself in the UI.
      if (!entry.isHost) {
        onEvent?.({ type: 'peer_joined', id: clientId, name: msg.name });
      }
      break;
    }
    case 'offer':
    case 'answer':
    case 'ice_candidate': {
      if (typeof msg.to !== 'string' || !clients.has(msg.to)) {
        if (__DEV__) console.warn(`[SignalingServer] ${msg.type} for unknown peer:`, msg.to);
        return;
      }
      _send(msg.to, { ...msg, from: clientId });
      break;
    }
    default:
      if (__DEV__) console.warn('[SignalingServer] unknown message type:', msg.type);
  }
}

function _send(clientId, msg) {
  const entry = clients.get(clientId);
  if (!entry?.socket) return;
  try {
    entry.socket.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    if (__DEV__) console.warn('[SignalingServer] write to', clientId, 'failed:', err?.message ?? err);
    try { entry.socket.destroy(); } catch (_) { /* ignore */ }
    clients.delete(clientId);
  }
}

function _broadcast(msg, excludeId) {
  clients.forEach((_, id) => {
    if (id !== excludeId) _send(id, msg);
  });
}
