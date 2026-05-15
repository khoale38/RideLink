/**
 * Tests for the signaling server auth gate and buffer cap.
 * We stub TcpSocket.createServer so we can drive synthetic client sockets
 * and assert how the server reacts to bad input.
 */

import TcpSocket from 'react-native-tcp-socket';
import { startSignalingServer, stopSignalingServer } from '../src/services/SignalingServer';

function makeSocket() {
  const handlers = {};
  return {
    on: jest.fn((ev, fn) => { handlers[ev] = fn; }),
    write: jest.fn(),
    destroy: jest.fn(),
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

test('oversized buffer kills the client', () => {
  startSignalingServer('hunter22', jest.fn());
  const socket = makeSocket();
  connectionHandler(socket);

  // 65KB without a newline — past the 64KB cap.
  const huge = 'A'.repeat(65 * 1024);
  socket._emit('data', Buffer.from(huge));
  expect(socket.destroy).toHaveBeenCalled();
});
