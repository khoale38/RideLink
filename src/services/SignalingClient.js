/**
 * TCP signaling client — connects to the host phone's embedded TCP server.
 * Uses newline-delimited JSON framing.
 *
 * Reconnect behavior: after the first successful connect, if the socket drops
 * (tunnel, range, brief WiFi blip), we auto-reconnect with exponential backoff.
 * The caller registers handlers.reconnecting / handlers.reconnected to update UI,
 * and we re-send the original `join` payload on each successful reconnect so the
 * server re-adds us to the peer list.
 */
/* global Buffer */
import TcpSocket from 'react-native-tcp-socket';

const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
// Give up after this many consecutive reconnect failures. With exponential
// backoff (1,2,4,8,15s) this is roughly 30s of trying before we surface
// "host is gone" to the UI instead of spinning forever.
const MAX_RECONNECT_ATTEMPTS = 5;

export class SignalingClient {
  constructor(host, port, handlers) {
    this.host = host;
    this.port = port;
    this.handlers = handlers;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.everConnected = false;       // gate reconnect attempts on first success
    this.intentionallyClosed = false; // set by disconnect() to stop reconnects
    this.joinPayload = null;          // last 'join' message, replayed on reconnect
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  connect() {
    // Reset the reconnect ladder so an instance that previously hit gave_up
    // can be reused: clear the latch, drop any pending timer, zero the
    // attempt counter. Without this, the next failure would immediately
    // re-fire gave_up because the counter is still at MAX.
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return this._openSocket();
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) reject(err); else resolve();
      };

      const timeout = setTimeout(() => {
        try { this.socket?.destroy(); } catch (_) { /* ignore */ }
        finish(new Error(`Signaling connect timed out after ${CONNECT_TIMEOUT_MS}ms (${this.host}:${this.port})`));
      }, CONNECT_TIMEOUT_MS);

      try {
        this.socket = TcpSocket.createConnection(
          { host: this.host, port: this.port },
          () => {
            this.connected = true;
            this.reconnectAttempt = 0;
            const wasReconnect = this.everConnected;
            this.everConnected = true;
            finish();
            if (wasReconnect) {
              // Replay join so the server re-adds us to the peer list.
              if (this.joinPayload) this.send(this.joinPayload);
              this.handlers.reconnected?.();
            }
          },
        );
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.buffer = Buffer.alloc(0); // fresh framing buffer per connection

      this.socket.on('data', (raw) => {
        // Buffer raw bytes so a multibyte UTF-8 char split across TCP chunks
        // decodes correctly. Only stringify on \n boundaries.
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        if (this.buffer.length > MAX_BUFFER_BYTES) {
          if (__DEV__) console.warn('[Signaling] receive buffer overflow, dropping connection');
          try { this.socket?.destroy(); } catch (_) { /* ignore */ }
          this.buffer = Buffer.alloc(0);
          return;
        }

        let nl;
        while ((nl = this.buffer.indexOf(0x0a)) !== -1) {
          const lineBuf = this.buffer.subarray(0, nl);
          this.buffer = this.buffer.subarray(nl + 1);
          if (lineBuf.length > MAX_LINE_BYTES) {
            if (__DEV__) console.warn('[Signaling] oversized message from host — dropping connection');
            try { this.socket?.destroy(); } catch (_) { /* ignore */ }
            this.buffer = Buffer.alloc(0);
            return;
          }
          const line = lineBuf.toString('utf8');
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (err) {
            if (__DEV__) console.warn('[Signaling] dropped malformed message:', line);
            continue;
          }
          try {
            this.handlers[msg.type]?.(msg);
          } catch (err) {
            if (__DEV__) console.warn('[Signaling] handler for', msg.type, 'threw:', err);
          }
        }
      });

      // Per-socket latch: both 'error' and 'close' typically fire for the
      // same disconnect; without this, the second one races with the
      // reconnect timer (if the first scheduled attempt has already fired,
      // the early `if (this.reconnectTimer)` guard no longer blocks, and
      // reconnectAttempt double-advances).
      let dead = false;
      const markDead = () => {
        if (dead) return;
        dead = true;
        this.connected = false;
        this._scheduleReconnect();
      };

      this.socket.on('error', (err) => {
        if (!settled) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
        markDead();
      });

      this.socket.on('close', () => {
        // disconnected fires once per real disconnect (only after we ever
        // connected — pre-connect 'close' from a failed initial dial is
        // surfaced to the caller via the rejected connect() promise instead).
        if (!dead && this.everConnected) this.handlers.disconnected?.();
        markDead();
      });
    });
  }

  _scheduleReconnect() {
    if (this.intentionallyClosed) return;
    if (!this.everConnected) return;        // initial connect failed → let caller decide
    if (this.reconnectTimer) return;        // already scheduled

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // Stop trying — host is almost certainly gone. UI gives up gracefully.
      this.intentionallyClosed = true;
      this.handlers.gave_up?.();
      return;
    }

    const attempt = ++this.reconnectAttempt;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    if (__DEV__) console.warn(`[Signaling] reconnect attempt ${attempt} in ${delay}ms`);
    this.handlers.reconnecting?.({ attempt, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyClosed) return;
      this._openSocket().catch(() => {
        // _openSocket's error handler already schedules the next attempt
      });
    }, delay);
  }

  send(msg) {
    if (!this.socket || !this.connected) return false;
    if (msg?.type === 'join') this.joinPayload = msg; // remember for replay
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      if (__DEV__) console.warn('[Signaling] write failed:', err?.message ?? err);
      return false;
    }
  }

  disconnect() {
    this.intentionallyClosed = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.socket?.destroy(); } catch (_) { /* ignore */ }
    this.socket = null;
  }
}
