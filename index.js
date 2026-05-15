/**
 * @format
 */

// Polyfill crypto.getRandomValues for native — must be imported before any
// module that calls it (e.g. SignalingServer's UUID generator).
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
