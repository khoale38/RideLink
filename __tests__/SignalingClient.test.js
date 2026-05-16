/**
 * Tests for SignalingClient reconnect logic — backoff ladder, joinPayload
 * replay on successful reconnect, and the reset-after-gave_up path that lets
 * an instance be `.connect()`'d again instead of latching closed forever.
 */

import TcpSocket from 'react-native-tcp-socket';
import { SignalingClient } from '../src/services/SignalingClient';

function makeSocket() {
  const handlers = {};
  return {
    on: jest.fn((ev, fn) => { handlers[ev] = fn; }),
    write: jest.fn(),
    destroy: jest.fn(),
    _emit: (ev, ...args) => handlers[ev]?.(...args),
    _handlers: handlers,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('replays joinPayload on successful reconnect', async () => {
  let sock = makeSocket();
  let onConnect = null;
  TcpSocket.createConnection.mockImplementation((_opts, cb) => {
    onConnect = cb;
    return sock;
  });

  const client = new SignalingClient('127.0.0.1', 8765, { reconnecting: jest.fn(), reconnected: jest.fn() });
  const p = client.connect();
  onConnect();
  await p;
  client.send({ type: 'join', name: 'Alice', password: 'pw' });
  expect(sock.write).toHaveBeenCalledWith(expect.stringContaining('"type":"join"'));

  // Install the new mock BEFORE the close → backoff fires, otherwise the
  // reconnect attempt reuses the original socket mock.
  const newSock = makeSocket();
  let secondConnectCb = null;
  TcpSocket.createConnection.mockImplementation((_opts, cb) => {
    secondConnectCb = cb;
    return newSock;
  });
  sock.write.mockClear();
  sock._emit('close');
  jest.advanceTimersByTime(1500); // past the 1000ms first-attempt backoff
  secondConnectCb?.();
  await Promise.resolve();

  expect(newSock.write).toHaveBeenCalledWith(expect.stringContaining('"type":"join"'));
});

test('connect() after gave_up resets reconnect counter so the instance is reusable', async () => {
  const sock = makeSocket();
  TcpSocket.createConnection.mockImplementation((_opts, cb) => { cb(); return sock; });

  const handlers = { gave_up: jest.fn() };
  const client = new SignalingClient('127.0.0.1', 8765, handlers);
  await client.connect();

  // Force the gave_up path: pretend we've already burned MAX attempts.
  // Kept in sync with MAX_RECONNECT_ATTEMPTS in SignalingClient.
  client.reconnectAttempt = 10;
  client._scheduleReconnect.call?.(client); // no-op if private; call internal directly
  // Drive it deterministically:
  client.everConnected = true;
  client.intentionallyClosed = false;
  // Re-run private; jest can reach because methods are plain class methods.
  client._scheduleReconnect();
  expect(handlers.gave_up).toHaveBeenCalled();
  expect(client.intentionallyClosed).toBe(true);

  // Now caller invokes connect() again — must clear the latch and reset
  // the attempt counter, otherwise the next failure re-fires gave_up.
  await client.connect();
  expect(client.intentionallyClosed).toBe(false);
  expect(client.reconnectAttempt).toBe(0);
});
