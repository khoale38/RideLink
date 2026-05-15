RideLink is a React Native motorcycle/bike intercom that uses a host phone's
Wi-Fi hotspot as the transport for WebRTC voice between riders, with
voice-activated transmission (VOX).

# Threat Model — LAN-only

**RideLink is designed to run on a private Wi-Fi hotspot and is not safe to
expose to public or shared networks.** Specifically:

- The signaling channel (TCP/JSON between guests and the host) is **not
  encrypted and not authenticated** beyond what the underlying Wi-Fi provides.
  Confidentiality and integrity rely entirely on WPA2/WPA3 protecting the
  hotspot LAN.
- WebRTC media itself is DTLS/SRTP encrypted end-to-end between peers, but
  signaling MITM on the LAN can redirect or drop streams.
- The host enforces a loopback-only check before accepting "host" identity
  claims, so LAN guests cannot impersonate the host. Guests trust the host.
- There is no STUN/TURN: connectivity is LAN-direct only. RideLink will not
  work over the public internet or across NATs by design.

**Do not run RideLink on:** open guest Wi-Fi, conference/coffee-shop networks,
or any network where you do not control who else is associated. Always use a
WPA2/WPA3-protected hotspot with a strong password chosen by the host at
hotspot-setup time (the app no longer ships a hardcoded password).

If you ever want to deploy beyond a private hotspot, the signaling channel
will need TLS (or some authenticated framing) and a real auth/identity layer —
the current design intentionally trusts the LAN.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
