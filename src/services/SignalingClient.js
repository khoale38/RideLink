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
import { logger } from './logger';

const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
// Give up after this many consecutive reconnect failures. With exponential
// backoff capped at 30s (1,2,4,8,16,30,30,30,30,30) this is roughly ~2.5
// minutes of trying — long enough to survive a real-world motorcycle
// tunnel without forcing the rider to manually rejoin on the other side.
const MAX_RECONNECT_ATTEMPTS = 10;

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
    // Latched true when the reconnect ladder runs out — semantically distinct
    // from intentionallyClosed (user-driven disconnect). Both gate the
    // _scheduleReconnect short-circuit, but reusing intentionallyClosed for
    // gave-up made "why didn't we keep trying?" indistinguishable in logs.
    this.gaveUp = false;
    this.joinPayload = null;          // last 'join' message, replayed on reconnect
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  connect() {
    // Single seam for resuming the reconnect ladder. Both flags and the
    // attempt counter must move together — clearing intentionallyClosed
    // without zeroing reconnectAttempt would let a fresh connect()
    // immediately fire gave_up if the prior session had topped out. The
    // _resetReconnectLadder helper exists so a future maintainer can't
    // forget one half of the pair (see CONTRACT comment in _openSocket).
    this._resetReconnectLadder();
    return this._openSocket();
  }

  _resetReconnectLadder() {
    this.intentionallyClosed = false;
    this.gaveUp = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _openSocket() {
    // CONTRACT: callers must come through connect() unless they're the
    // internal reconnect ladder. connect() resets `intentionallyClosed` and
    // `gaveUp`; _openSocket does NOT. The reconnect ladder is safe because
    // _scheduleReconnect short-circuits on both flags before scheduling a
    // call here. If you ever add another caller, route it through connect()
    // or it will succeed but the next disconnect won't auto-reconnect.
    //
    // Drop listeners on any prior socket BEFORE reassigning this.socket.
    // disconnect() does this on the intentional path, but the reconnect
    // ladder reaches _openSocket without going through disconnect(); without
    // this, a late 'close'/'error' from the previous socket can re-enter
    // markDead on the healthy new instance and trigger duplicate reconnects.
    if (this.socket) {
      try { this.socket.removeAllListeners?.(); } catch (_) { /* ignore */ }
      try { this.socket.destroy(); } catch (_) { /* ignore */ }
      this.socket = null;
    }
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
            // If the caller disconnected between scheduling and resolving
            // (or the reconnect ladder gave up), abandon the socket — don't
            // replay the join into a session the caller has already torn
            // down. disconnect() already destroyed the prior socket, but a
            // freshly-opened socket here would otherwise be orphaned.
            //
            // Note: we don't reset reconnectAttempt / everConnected here.
            // `intentionallyClosed=true` gates _scheduleReconnect at line
            // ~192, so the ladder won't fire again regardless of those
            // counters. If you ever clear intentionallyClosed without
            // also resetting the counters, the ladder may resume from
            // mid-attempt — route through connect() to reset both.
            if (this.intentionallyClosed || this.gaveUp) {
              try { this.socket?.removeAllListeners?.(); } catch (_) { /* ignore */ }
              try { this.socket?.destroy(); } catch (_) { /* ignore */ }
              this.socket = null;
              finish(new Error('connect resolved after disconnect — abandoning'));
              return;
            }
            this.connected = true;
            this.reconnectAttempt = 0;
            const wasReconnect = this.everConnected;
            this.everConnected = true;
            finish();
            if (wasReconnect) {
              // Replay join so the server re-adds us to the peer list. This
              // depends on `this.connected = true` already being set above —
              // `send()` short-circuits when connected is false. If you
              // reorder this block, make sure connected is flipped first.
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
          logger.warn('Signaling', 'receive buffer overflow, dropping connection');
          try { this.socket?.destroy(); } catch (_) { /* ignore */ }
          this.buffer = Buffer.alloc(0);
          return;
        }

        let nl;
        while ((nl = this.buffer.indexOf(0x0a)) !== -1) {
          // See SignalingServer for why we re-wrap: React Native's buffer
          // polyfill returns a plain Uint8Array from .subarray, so toString
          // would otherwise produce comma-joined byte values instead of UTF-8.
          const rawSlice = this.buffer.subarray(0, nl);
          const lineBuf = Buffer.isBuffer(rawSlice) ? rawSlice : Buffer.from(rawSlice);
          const tailSlice = this.buffer.subarray(nl + 1);
          this.buffer = Buffer.isBuffer(tailSlice) ? tailSlice : Buffer.from(tailSlice);
          if (lineBuf.length > MAX_LINE_BYTES) {
            logger.warn('Signaling', 'oversized message from host — dropping connection');
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
            logger.warn('Signaling', 'dropped malformed message', { line });
            continue;
          }
          try {
            this.handlers[msg.type]?.(msg);
          } catch (err) {
            logger.warn('Signaling', `handler for ${msg.type} threw`, { error: err?.message ?? String(err) });
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
    if (this.intentionallyClosed || this.gaveUp) return;
    if (!this.everConnected) return;        // initial connect failed → let caller decide
    if (this.reconnectTimer) return;        // already scheduled

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // Stop trying — host is almost certainly gone. UI gives up gracefully.
      this.gaveUp = true;
      this.handlers.gave_up?.();
      return;
    }

    const attempt = ++this.reconnectAttempt;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    logger.warn('Signaling', `reconnect attempt ${attempt} in ${delay}ms`);
    this.handlers.reconnecting?.({ attempt, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyClosed || this.gaveUp) return;
      this._openSocket().catch(() => {
        // _openSocket's async error path schedules the next attempt via
        // the 'error' listener's markDead() — by the time we land here,
        // a reconnectTimer is already set (or another error is in-flight).
        // The guard at the top of _scheduleReconnect short-circuits on
        // `if (this.reconnectTimer) return`, so calling it again is safe
        // and idempotent. This re-arm covers the rare path where
        // _openSocket rejects WITHOUT having installed an 'error' listener
        // (e.g. TcpSocket.createConnection throwing synchronously); the
        // double-call is intentional and guard-protected.
        this._scheduleReconnect();
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
      logger.warn('Signaling', 'write failed', { error: err?.message ?? String(err) });
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
    // Drop listeners before destroy so any late 'close'/'error' from the
    // platform layer can't re-enter markDead() on a torn-down instance.
    try { this.socket?.removeAllListeners?.(); } catch (_) { /* ignore */ }
    try { this.socket?.destroy(); } catch (_) { /* ignore */ }
    this.socket = null;
  }
}
