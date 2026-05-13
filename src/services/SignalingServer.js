/**
 * Embedded TCP signaling server — runs on the hotspot host phone.
 * Uses newline-delimited JSON over TCP (no Node.js needed).
 * Guests connect to tcp://192.168.43.1:8765 (Android) or 172.20.10.1:8765 (iOS)
 */
import TcpSocket from 'react-native-tcp-socket';
import { v4 as uuidv4 } from 'uuid';

export const SIGNALING_PORT = 8765;

let server = null;
const clients = new Map(); // clientId -> { socket, name, buffer }

export function startSignalingServer(onEvent) {
  if (server) return;

  server = TcpSocket.createServer((socket) => {
    const clientId = uuidv4();
    clients.set(clientId, { socket, name: null, buffer: '' });

    socket.on('data', (raw) => {
      const entry = clients.get(clientId);
      if (!entry) return;

      // Buffer incoming data and split on newlines (framing)
      entry.buffer += raw.toString();
      const lines = entry.buffer.split('\n');
      entry.buffer = lines.pop(); // last partial line stays in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        _handleMessage(clientId, msg, onEvent);
      }
    });

    socket.on('close', () => {
      const entry = clients.get(clientId);
      if (entry) {
        _broadcast({ type: 'peer_left', id: clientId, name: entry.name }, clientId);
        onEvent?.({ type: 'peer_left', id: clientId, name: entry.name });
      }
      clients.delete(clientId);
    });

    socket.on('error', () => {
      clients.delete(clientId);
    });
  });

  server.listen({ port: SIGNALING_PORT, host: '0.0.0.0' }, () => {
    onEvent?.({ type: 'server_started', port: SIGNALING_PORT });
  });
}

export function stopSignalingServer() {
  if (!server) return;
  server.close();
  server = null;
  clients.clear();
}

function _handleMessage(clientId, msg, onEvent) {
  const entry = clients.get(clientId);
  if (!entry) return;

  switch (msg.type) {
    case 'join': {
      entry.name = msg.name;
      // Send the new peer a list of everyone already connected
      const peers = [];
      clients.forEach((c, id) => {
        if (id !== clientId && c.name) peers.push({ id, name: c.name });
      });
      _send(clientId, { type: 'peer_list', peers, yourId: clientId });
      // Tell everyone else about the new peer
      _broadcast({ type: 'peer_joined', id: clientId, name: msg.name }, clientId);
      onEvent?.({ type: 'peer_joined', id: clientId, name: msg.name });
      break;
    }
    case 'offer':
    case 'answer':
    case 'ice_candidate': {
      _send(msg.to, { ...msg, from: clientId });
      break;
    }
  }
}

function _send(clientId, msg) {
  const entry = clients.get(clientId);
  if (entry?.socket) {
    entry.socket.write(JSON.stringify(msg) + '\n');
  }
}

function _broadcast(msg, excludeId) {
  clients.forEach((_, id) => {
    if (id !== excludeId) _send(id, msg);
  });
}
