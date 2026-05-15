/**
 * Locks in the start/stop ordering and permission gating for the Android
 * foreground service. Commit e55e9e8 fixed a bug where start() ran before the
 * notification permission was granted, which caused Android to kill the
 * service almost immediately. These tests guard that ordering.
 */

const mockNativeStart = jest.fn().mockResolvedValue(undefined);
const mockNativeStop = jest.fn().mockResolvedValue(undefined);
const mockCheck = jest.fn();
const mockRequest = jest.fn();

jest.mock('react-native', () => ({
  NativeModules: {
    IntercomService: { start: mockNativeStart, stop: mockNativeStop },
  },
  Platform: { OS: 'android', Version: 33 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    check: (...args) => mockCheck(...args),
    request: (...args) => mockRequest(...args),
  },
}));

describe('IntercomService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('startIntercomService requests notification permission before starting native service', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequest.mockResolvedValue('granted');
    const callOrder = [];
    mockRequest.mockImplementationOnce(async () => { callOrder.push('request'); return 'granted'; });
    mockNativeStart.mockImplementationOnce(async () => { callOrder.push('start'); });

    const { startIntercomService } = require('../src/services/IntercomService');
    await startIntercomService('My Ride');

    expect(callOrder).toEqual(['request', 'start']);
    expect(mockNativeStart).toHaveBeenCalledWith('My Ride');
  });

  test('startIntercomService throws when notification permission denied (does not start service)', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequest.mockResolvedValue('denied');

    const { startIntercomService } = require('../src/services/IntercomService');
    await expect(startIntercomService('Group')).rejects.toThrow(/Notification permission/);
    expect(mockNativeStart).not.toHaveBeenCalled();
  });

  test('startIntercomService skips re-request when already granted', async () => {
    mockCheck.mockResolvedValue(true);

    const { startIntercomService } = require('../src/services/IntercomService');
    await startIntercomService();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockNativeStart).toHaveBeenCalledWith('Group');
  });

  test('stopIntercomService swallows native errors', async () => {
    mockNativeStop.mockRejectedValueOnce(new Error('boom'));
    const { stopIntercomService } = require('../src/services/IntercomService');
    await expect(stopIntercomService()).resolves.toBeUndefined();
  });
});
