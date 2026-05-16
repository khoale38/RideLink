/**
 * Tests for the signaling server's join gate, host claim, and buffer cap.
 * We stub TcpSocket.createServer so we can drive synthetic client sockets
 * and assert how the server reacts to bad input.
 *
 * Note: in-app signaling auth was dropped — WPA2 on the hotspot gates LAN
 * access. The server still requires a `join` first (identity gate) so peers
 * can't send anonymous offers/ICE before being added to the roster.
 */

import TcpSocket from 'react-native-tcp-socket';
import { startSignalingServer, stopSignalingServer } from '../src/services/SignalingServer';

function makeSocket(remoteAddress = '192.168.43.42') {
  const handlers = {};
  return {
    on: jest.fn((ev, fn) => { handlers[ev] = fn; }),
    write: jest.fn(),
    end: jest.fn(),
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

test('client sending non-join before identifying is dropped', () => {
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'offer', to: 'someone', sdp: {} }) + '\n'));
  expect(socket.destroy).toHaveBeenCalled();
});

test('join with a name receives peer_list', () => {
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice' }) + '\n'));
  expect(socket.destroy).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"type":"peer_list"'));
});

test('join without a name is ignored', () => {
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  socket._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: '' }) + '\n'));
  // Empty name: server returns without setting joined or writing peer_list.
  expect(socket.write).not.toHaveBeenCalledWith(expect.stringContaining('"type":"peer_list"'));
});

test('stopSignalingServer broadcasts room_closed to non-host clients before closing', () => {
  startSignalingServer(jest.fn());
  const hostSock = makeSocket('127.0.0.1');
  const guestSock = makeSocket();
  connectionHandler(hostSock);
  connectionHandler(guestSock);
  hostSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Host', isHost: true }) + '\n'));
  guestSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice' }) + '\n'));
  hostSock.write.mockClear();
  guestSock.write.mockClear();

  stopSignalingServer();

  // The room_closed frame is delivered via socket.end(payload) so the FIN
  // is queued *after* the bytes flush — an immediate destroy() could drop
  // the un-flushed buffer and leave guests with "Lost connection" instead
  // of the intended "Host closed the group" notice.
  expect(guestSock.end).toHaveBeenCalledWith(expect.stringContaining('"type":"room_closed"'));
  expect(guestSock.write).not.toHaveBeenCalled();
  expect(hostSock.end).not.toHaveBeenCalled();
  expect(hostSock.write).not.toHaveBeenCalled();
  expect(hostSock.destroy).toHaveBeenCalled();
});

test('non-loopback client claiming isHost is downgraded to guest', () => {
  const onEvent = jest.fn();
  startSignalingServer(onEvent);
  const lanSock = makeSocket('192.168.43.99');
  connectionHandler(lanSock);
  lanSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Mallory', isHost: true }) + '\n'));

  expect(lanSock.destroy).not.toHaveBeenCalled();
  expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'peer_joined', name: 'Mallory' }));
});

test('loopback client claiming isHost is accepted as host (no self-notify)', () => {
  const onEvent = jest.fn();
  startSignalingServer(onEvent);
  const hostSock = makeSocket('127.0.0.1');
  connectionHandler(hostSock);
  hostSock._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Host', isHost: true }) + '\n'));

  expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'peer_joined' }));
});

test('join timeout drops a silent socket', () => {
  jest.useFakeTimers();
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  jest.advanceTimersByTime(11000);
  expect(socket.destroy).toHaveBeenCalled();
  jest.useRealTimers();
});

test('pre-join sockets are excluded from broadcasts', () => {
  startSignalingServer(jest.fn());
  const joined = makeSocket();
  const silent = makeSocket();
  connectionHandler(joined);
  connectionHandler(silent); // never sends join
  joined._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Alice' }) + '\n'));
  joined.write.mockClear();
  silent.write.mockClear();

  const second = makeSocket();
  connectionHandler(second);
  second._emit('data', Buffer.from(JSON.stringify({ type: 'join', name: 'Bob' }) + '\n'));
  expect(silent.write).not.toHaveBeenCalled();
  expect(joined.write).toHaveBeenCalledWith(expect.stringContaining('"type":"peer_joined"'));
});

test('multibyte UTF-8 split across TCP chunks decodes correctly', () => {
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  const payload = JSON.stringify({ type: 'join', name: 'Al•ice' }) + '\n';
  const buf = Buffer.from(payload, 'utf8');
  const splitAt = buf.indexOf(0xe2) + 1;
  socket._emit('data', buf.subarray(0, splitAt));
  socket._emit('data', buf.subarray(splitAt));

  expect(socket.destroy).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"yourId"'));
});

test('oversized buffer kills the client', () => {
  startSignalingServer(jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  const huge = 'A'.repeat(65 * 1024);
  socket._emit('data', Buffer.from(huge));
  expect(socket.destroy).toHaveBeenCalled();
});
