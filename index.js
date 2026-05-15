/**
 * @format
 */

// Polyfill crypto.getRandomValues for native — must be imported before any
// module that calls it (e.g. SignalingServer's UUID generator).
import 'react-native-get-random-values';
// Polyfill Buffer — React Native doesn't expose it as a global, and our
// signaling layer uses it for byte-accurate framing. Must be installed before
// any module that references `Buffer` at module load.
import { Buffer } from 'buffer';
if (typeof global.Buffer === 'undefined') global.Buffer = Buffer;
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
