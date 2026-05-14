import { NativeModules, Platform, PermissionsAndroid } from 'react-native';

const { IntercomService } = NativeModules;

// Android 13+ won't post our ongoing-call notification (which keeps the
// foreground service alive) unless the user has granted POST_NOTIFICATIONS.
// Without the notification, Play Services kills the service almost
// immediately, so we treat this as part of the start-up flow.
async function ensureNotificationPermission() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version < 33) return true; // pre-Android 13: implicit grant
  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!perm) return true;
  const already = await PermissionsAndroid.check(perm);
  if (already) return true;
  const res = await PermissionsAndroid.request(perm, {
    title: 'Show intercom notification',
    message: 'RideLink shows an ongoing notification so it can keep the mic running while your screen is off.',
    buttonPositive: 'Allow',
  });
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export async function startIntercomService(groupName) {
  if (Platform.OS !== 'android') return; // iOS uses UIBackgroundModes
  if (!IntercomService) return;          // dev / unlinked
  // POST_NOTIFICATIONS denial means Android will kill the foreground service
  // almost immediately on a locked screen — surface this as a real error so
  // the host/join flow can show the user what's wrong instead of pretending
  // it worked and dying mid-ride.
  const notifOk = await ensureNotificationPermission();
  if (!notifOk) {
    throw new Error('Notification permission denied — required to keep the intercom alive when the screen is off.');
  }
  await IntercomService.start(groupName ?? 'Group');
}

export async function stopIntercomService() {
  if (Platform.OS !== 'android') return;
  if (!IntercomService) return;
  try {
    await IntercomService.stop();
  } catch (err) {
    if (__DEV__) console.warn('[IntercomService] stop failed:', err?.message ?? err);
  }
}
