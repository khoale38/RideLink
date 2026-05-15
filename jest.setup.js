jest.mock('react-native-keep-awake', () => ({
  __esModule: true,
  default: { activate: jest.fn(), deactivate: jest.fn() },
  activate: jest.fn(),
  deactivate: jest.fn(),
}));

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
  RTCIceCandidate: jest.fn(),
  mediaDevices: { getUserMedia: jest.fn() },
}));

jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

jest.mock('react-native-wifi-reborn', () => ({
  loadWifiList: jest.fn(),
  connectToProtectedSSID: jest.fn(),
}));

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getDeviceName: jest.fn().mockResolvedValue('Test'),
    getModel: jest.fn().mockReturnValue('Test'),
  },
}));

jest.mock('@react-native-community/slider', () => 'Slider');
