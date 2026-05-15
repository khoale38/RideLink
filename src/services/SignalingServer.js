/**
 * Embedded TCP signaling server — runs on the hotspot host phone.
 * Uses newline-delimited JSON over TCP (no Node.js needed).
 * Guests connect to tcp://192.168.43.1:8765 (Android) or 172.20.10.1:8765 (iOS)
 */
/* global Buffer */
import TcpSocket from 'react-native-tcp-socket';
import { logger } from './logger';

// Crypto-strong v4 UUID. Relies on the `react-native-get-random-values`
// polyfill imported in index.js so `crypto.getRandomValues` is available.
function uuidv4() {
  const bytes = new Uint8Array(16);
  // eslint-disable-next-line no-undef
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else if (__DEV__) {
    // Test env without the polyfill — fall back so unit tests don't crash.
    console.warn('[SignalingServer] crypto.getRandomValues unavailable; using Math.random fallback (DEV ONLY)');
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  } else {
    // Production: refuse to mint guessable IDs. The polyfill is imported at
    // the top of index.js — if it's missing, the bundle is misconfigured.
    throw new Error('crypto.getRandomValues unavailable — react-native-get-random-values polyfill not loaded');
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
// Per-line cap. A real SDP is a few KB; ICE candidates are tiny. 32KB is
// generous. The buffer cap above only catches "no newline ever" — this
// catches "many oversized framed lines".
const MAX_LINE_BYTES = 32 * 1024;
// A client that connects but never sends a valid `join` within this window is
// dropped. Prevents slow-loris / passive socket scanning. Matched to the
// client-side CONNECT_TIMEOUT_MS so legit guests on marginal links aren't
// dropped before their first `join` lands.
const JOIN_TIMEOUT_MS = 10000;
const EMPTY_BUF = Buffer.alloc(0);

let server = null;
const clients = new Map(); // clientId -> { socket, name, buffer, joined, isHost, joinTimer, remoteAddress }

function _isLoopback(addr) {
  // react-native-tcp-socket sets remoteAddress on the server-side socket.
  // Loopback covers 127.0.0.0/8 and the IPv6 form. The host phone connects
  // its own signaling client via 127.0.0.1; guests cannot reach loopback
  // from a different device.
  if (typeof addr !== 'string') return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function startSignalingServer(onEvent) {
  if (server) return;

  server = TcpSocket.createServer((socket) => {
    const clientId = uuidv4();
    const remoteAddress = socket.remoteAddress ?? socket._remoteAddress ?? null;
    const joinTimer = setTimeout(() => {
      const entry = clients.get(clientId);
      if (entry && !entry.joined) {
        logger.warn('SignalingServer', 'join timeout — dropping idle socket', { clientId });
        try { entry.socket.destroy(); } catch (_) { /* ignore */ }
        clients.delete(clientId);
      }
    }, JOIN_TIMEOUT_MS);
    clients.set(clientId, { socket, name: null, buffer: EMPTY_BUF, joined: false, isHost: false, joinTimer, remoteAddress });

    socket.on('data', (raw) => {
      const entry = clients.get(clientId);
      if (!entry) return;

      // Buffer raw bytes (not strings) so multibyte UTF-8 chars split across
      // TCP chunks decode correctly. We only stringify on \n boundaries.
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      entry.buffer = entry.buffer.length ? Buffer.concat([entry.buffer, chunk]) : chunk;
      if (entry.buffer.length > MAX_BUFFER_BYTES) {
        if (__DEV__) console.warn('[SignalingServer] buffer overflow, dropping client', clientId);
        try { entry.socket.destroy(); } catch (_) { /* ignore */ }
        clients.delete(clientId);
        return;
      }

      let nl;
      while ((nl = entry.buffer.indexOf(0x0a)) !== -1) {
        const lineBuf = entry.buffer.subarray(0, nl);
        entry.buffer = entry.buffer.subarray(nl + 1);
        if (lineBuf.length > MAX_LINE_BYTES) {
          logger.warn('SignalingServer', 'oversized message dropped — closing client', { clientId, bytes: lineBuf.length });
          try { entry.socket.destroy(); } catch (_) { /* ignore */ }
          clients.delete(clientId);
          return;
        }
        const line = lineBuf.toString('utf8');
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // Log a short preview so we can tell apart "old guest sending the
          // wrong format" from "port scanner / HTTP probe / TLS hello".
          if (__DEV__) {
            const preview = line.length > 64 ? line.slice(0, 64) + '…' : line;
            console.warn('[SignalingServer] malformed message dropped from', clientId, JSON.stringify(preview));
          }
          continue;
        }
        try {
          _handleMessage(clientId, msg, onEvent);
        } catch (err) {
          if (__DEV__) console.warn('[SignalingServer] handler threw:', err);
        }
        // _handleMessage may have removed this client (e.g. failed auth).
        if (!clients.has(clientId)) return;
      }
    });

    socket.on('close', () => {
      const entry = clients.get(clientId);
      if (entry) {
        clearTimeout(entry.joinTimer);
        // Only notify peers about clients that actually joined — pre-join
        // sockets never appeared in any peer list, so a peer_left would be
        // a phantom event.
        if (entry.joined) {
          _broadcast({ type: 'peer_left', id: clientId, name: entry.name }, clientId);
          if (!entry.isHost) {
            onEvent?.({ type: 'peer_left', id: clientId, name: entry.name });
          }
        }
      }
      clients.delete(clientId);
    });

    socket.on('error', (err) => {
      if (__DEV__) console.warn('[SignalingServer] client socket error:', err?.message ?? err);
      const entry = clients.get(clientId);
      if (entry) {
        clearTimeout(entry.joinTimer);
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
  // Tell guests we're closing on purpose so their UI can route home instead
  // of showing "Connecting…" forever. Sent before destroy() so the byte
  // hits the wire before the FIN.
  clients.forEach((entry) => {
    if (entry.isHost || !entry.joined) return;
    try { entry.socket.write(JSON.stringify({ type: 'room_closed' }) + '\n'); } catch (_) { /* ignore */ }
  });
  clients.forEach((entry) => {
    clearTimeout(entry.joinTimer);
    try { entry.socket.destroy(); } catch (_) { /* ignore */ }
  });
  clients.clear();
  try { server.close(); } catch (_) { /* ignore */ }
  server = null;
}

function _handleMessage(clientId, msg, onEvent) {
  const entry = clients.get(clientId);
  if (!entry || !msg || typeof msg.type !== 'string') return;

  // Identity gate: every client must `join` (advertise their name) before the
  // server will relay anything else. WPA2 already gates LAN access, so we
  // don't take a password here — but we still require a `join` first so peers
  // can't send anonymous offers/ICE before being added to the roster.
  if (!entry.joined && msg.type !== 'join') {
    logger.warn('SignalingServer', 'pre-join message dropped', { type: msg.type, clientId });
    try { entry.socket.destroy(); } catch (_) { /* ignore */ }
    clients.delete(clientId);
    return;
  }

  switch (msg.type) {
    case 'join': {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return;
      entry.joined = true;
      entry.name = msg.name;
      // Host status is derived from the socket origin — only loopback peers
      // can claim host. A guest on the LAN sending `isHost: true` is ignored
      // (downgraded to guest), so it can't suppress host UI notifications
      // or impersonate the room owner.
      const claimedHost = !!msg.isHost;
      entry.isHost = claimedHost && _isLoopback(entry.remoteAddress);
      if (claimedHost && !entry.isHost) {
        logger.warn('SignalingServer', 'rejected non-loopback host claim', { clientId, remoteAddress: entry.remoteAddress });
      }
      clearTimeout(entry.joinTimer);
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
  // Only joined clients receive broadcasts. A half-open socket that hasn't
  // sent `join` yet has no business seeing peer_joined/peer_left/etc.
  clients.forEach((entry, id) => {
    if (id !== excludeId && entry.joined) _send(id, msg);
  });
}
