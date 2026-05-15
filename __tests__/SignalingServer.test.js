/**
 * Tests for the signaling server auth gate and buffer cap.
 * We stub TcpSocket.createServer so we can drive synthetic client sockets
 * and assert how the server reacts to bad input.
 */

import TcpSocket from 'react-native-tcp-socket';
import { startSignalingServer, stopSignalingServer } from '../src/services/SignalingServer';

function makeSocket(remoteAddress = '192.168.43.42') {
  const handlers = {};
  return {
    on: jest.fn((ev, fn) => { handlers[ev] = fn; }),
    write: jest.fn(),
    destroy: jest.fn(),
    remoteAddress,
    _emit: (ev, ...args) => handlers[ev]?.(...args),
  };
}

let connectionHandler = null;
const serverInstance = {
  on: jest.fn(),
  listen: jest.fn((opts, cb) => cb && cb()),
  close: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  TcpSocket.createServer.mockImplementation((onConn) => {
    connectionHandler = onConn;
    return serverInstance;
  });
});

afterEach(() => {
  stopSignalingServer();
});

test('startSignalingServer throws without a password', () => {
  expect(() => startSignalingServer('', jest.fn())).toThrow(/password/);
});

test('client sending non-join before auth is dropped', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'offer', to: 'someone', sdp: {} }) + '\n'));
  expect(socket.destroy).toHaveBeenCalled();
});

test('join with wrong password is rejected and socket destroyed', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Eve', password: 'guess' }) + '\n'));
  expect(socket.destroy).toHaveBeenCalled();
  expect(socket.write).not.toHaveBeenCalled();
});

test('join with correct password authenticates and receives peer_list', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice', password: 'hunter22' }) + '\n'));
  expect(socket.destroy).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"type":"peer_list"'));
});

test('stopSignalingServer broadcasts room_closed to non-host clients before closing', () => {
  startSignalingServer('hunter22', jest.fn());
  // Two clients: one host loopback, one guest.
  const hostSock = makeSocket('127.0.0.1');
  const guestSock = makeSocket();
  connectionHandler(hostSock);
  connectionHandler(guestSock);
  hostSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Host', isHost: true, password: 'hunter22' }) + '\n'));
  guestSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice', password: 'hunter22' }) + '\n'));
  hostSock.write.mockClear();
  guestSock.write.mockClear();

  stopSignalingServer();

  expect(guestSock.write).toHaveBeenCalledWith(expect.stringContaining('"type":"room_closed"'));
  // Host doesn't need the broadcast — it's the one closing the room.
  expect(hostSock.write).not.toHaveBeenCalled();
  expect(guestSock.destroy).toHaveBeenCalled();
  expect(hostSock.destroy).toHaveBeenCalled();
});

test('non-loopback client claiming isHost is downgraded to guest', () => {
  const onEvent = jest.fn();
  startSignalingServer('hunter22', onEvent);
  // A LAN guest sends isHost:true. The server must ignore the flag and
  // still emit a peer_joined event to the host UI — otherwise a malicious
  // guest could hide its presence.
  const lanSock = makeSocket('192.168.43.99');
  connectionHandler(lanSock);
  lanSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Mallory', isHost: true, password: 'hunter22' }) + '\n'));

  expect(lanSock.destroy).not.toHaveBeenCalled();
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'peer_joined', name: 'Mallory' }));
});

test('loopback client claiming isHost is accepted as host (no self-notify)', () => {
  const onEvent = jest.fn();
  startSignalingServer('hunter22', onEvent);
  const hostSock = makeSocket('127.0.0.1');
  connectionHandler(hostSock);
  hostSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Host', isHost: true, password: 'hunter22' }) + '\n'));

  // Host loopback connection must not appear as a peer_joined in the host's
  // own UI — it represents itself directly.
  expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'peer_joined' }));
});

test('auth timeout drops a silent socket', () => {
  jest.useFakeTimers();
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  // Advance past the 10s auth window without sending anything.
  jest.advanceTimersByTime(11000);
  expect(socket.destroy).toHaveBeenCalled();
  jest.useRealTimers();
});

test('pre-auth sockets are excluded from broadcasts', () => {
  startSignalingServer('hunter22', jest.fn());
  const authed = makeSocket();
  const silent = makeSocket();
  connectionHandler(authed);
  connectionHandler(silent); // never sends join
  authed._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice', password: 'hunter22' }) + '\n'));
  authed.write.mockClear();
  silent.write.mockClear();

  // Now a second authed client joins — should NOT trigger a write to `silent`.
  const second = makeSocket();
  connectionHandler(second);
  second._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Bob', password: 'hunter22' }) + '\n'));
  expect(silent.write).not.toHaveBeenCalled();
  expect(authed.write).toHaveBeenCalledWith(expect.stringContaining('"type":"peer_joined"'));
});

test('multibyte UTF-8 split across TCP chunks decodes correctly', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  // Name with a 3-byte UTF-8 char (•, U+2022). Split the encoded bytes
  // mid-character across two `data` events — old string-concat code would
  // turn the split byte into U+FFFD and JSON.parse would still succeed but
  // with a corrupted name. New byte-buffer code must reassemble cleanly.
  const payload = JSON.stringify({ type: 'join', name: 'Al•ice', password: 'hunter22' }) + '\n';
  const buf = Buffer.from(payload, 'utf8');
  const splitAt = buf.indexOf(0xe2) + 1; // middle of the • multibyte sequence
  socket._emit('data', buf.subarray(0, splitAt));
  socket._emit('data', buf.subarray(splitAt));

  expect(socket.destroy).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"yourId"'));
});

test('oversized buffer kills the client', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  // 65KB without a newline — past the 64KB cap.
  const huge = 'A'.repeat(65 * 1024);
  socket._emit('data', Buffer.from(huge));
  expect(socket.destroy).toHaveBeenCalled();
});
