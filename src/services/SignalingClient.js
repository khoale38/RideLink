/**
 * TCP signaling client — connects to the host phone's embedded TCP server.
 * Uses newline-delimited JSON framing.
 */
import TcpSocket from 'react-native-tcp-socket';

export class SignalingClient {
  constructor(host, port, handlers) {
    this.host = host;
    this.port = port;
    this.handlers = handlers;
    this.socket = null;
    this.buffer = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = TcpSocket.createConnection(
        { host: this.host, port: this.port },
        () => resolve(),
      );

      this.socket.on('data', (raw) => {
        this.buffer += raw.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          this.handlers[msg.type]?.(msg);
        }
      });

      this.socket.on('error', (err) => {
        reject(err);
        this.handlers.disconnected?.();
      });

      this.socket.on('close', () => {
        this.handlers.disconnected?.();
      });
    });
  }

  send(msg) {
    this.socket?.write(JSON.stringify(msg) + '\n');
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = null;
  }
}
