import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Alert, StatusBar } from 'react-native';
import KeepAwake from 'react-native-keep-awake';
import { HomeScreen } from './src/screens/HomeScreen';
import { GroupScreen } from './src/screens/GroupScreen';
import { useGroupStore } from './src/store/groupStore';
import { useIntercom } from './src/hooks/useIntercom';
import { useVOX } from './src/hooks/useVOX';
import { ErrorBoundary } from './src/components/ErrorBoundary';

function App() {
  const store = useGroupStore();
  const { hostGroup, joinGroup, leaveGroup, toggleMute, localStream, setTransmitting } = useIntercom(store, {
    onKicked: async (reason: 'host_closed_room' | 'connection_lost') => {
      // Await teardown so a user tapping Host/Join immediately after the alert
      // dismisses doesn't race a still-running signaling server / FG service.
      try { await leaveGroup(); } catch { /* best-effort */ }
      setScreen('home');
      Alert.alert(
        reason === 'host_closed_room' ? 'Host closed the group' : 'Lost connection',
        reason === 'host_closed_room'
          ? 'The host ended the ride. You\'ve been returned to the home screen.'
          : 'Could not reach the host after several attempts. The hotspot may be out of range or the host left.',
      );
    },
  });
  const [screen, setScreen] = useState<'home' | 'group'>('home');
  const [voxEnabled, setVoxEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  // Run VOX whenever we're in a group (not just when voxEnabled), so the
  // self-speaking indicator works even with VOX off. Transmission is gated
  // separately below via vox.transmit + voxEnabled.
  const vox = useVOX(localStream, screen === 'group' && !store.muted);

  // Single source of truth for whether outbound mic audio reaches peers.
  // - muted: never transmit
  // - VOX off: always transmit
  // - VOX on: transmit only while VOX gate is open (vox.transmit)
  //
  // We gate at the peer-sender level (replaceTrack) rather than on the source
  // track. Disabling the source would zero out media-source audioLevel and
  // deadlock VOX — level=0 forever → gate never opens → border never lights.
  useEffect(() => {
    const desired = screen === 'group' && !store.muted && (!voxEnabled || vox.transmit);
    setTransmitting(desired);
  }, [localStream, screen, store.muted, voxEnabled, vox.transmit, setTransmitting]);

  const handleHost = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await hostGroup(name);
      setScreen('group');
    } catch (err: any) {
      // useIntercom.hostGroup already awaits leaveGroup() in its catch, so a
      // second leaveGroup() here would race the first. Just surface the error.
      Alert.alert('Could not start group', err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async (name: string, password: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await joinGroup(name, password);
      setScreen('group');
    } catch (err: any) {
      // See handleHost — joinGroup already cleans up on failure.
      Alert.alert('Could not join group', err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async () => {
    if (busy) return;
    // `busy` covers the full teardown window so a user tapping Host/Join
    // immediately after Leave can't race a still-running stopSignalingServer
    // / stopIntercomService. The session lock inside useIntercom serializes
    // even if they do, but reflecting it in the UI state prevents the
    // disabled-button flicker and the second Alert that would surface from
    // a synchronously-rejected start.
    setBusy(true);
    // Flip the screen first so the UI feels instantaneous; native teardown
    // continues in the background. Errors here are best-effort — leaveGroup
    // already swallows them internally.
    setScreen('home');
    try { await leaveGroup(); } catch { /* best-effort */ }
    finally { setBusy(false); }
  };

  // Keep the screen on whenever we're in a group — riders can't tap the screen
  // to wake it while on a bike, and a locked screen kills audio/signaling.
  useEffect(() => {
    if (screen === 'group') {
      KeepAwake.activate();
      return () => KeepAwake.deactivate();
    }
  }, [screen]);

  // Ensure signaling server / sockets are torn down if the app unmounts mid-session.
  // We use a ref so the cleanup fires ONLY on real unmount, not every time
  // leaveGroup's identity changes (it does, because the store object identity
  // churns on every render).
  const leaveGroupRef = useRef(leaveGroup);
  useEffect(() => { leaveGroupRef.current = leaveGroup; }, [leaveGroup]);
  useEffect(() => () => {
    // Run synchronously on unmount. Previously this used setTimeout(0) to
    // avoid React setState-during-unmount warnings, but a deferred callback
    // can be dropped entirely if the JS context is torn down (hot reload,
    // process kill) — leaving the signaling server and Android foreground
    // service alive across reloads. The store's setState calls happen
    // outside the React render path and won't warn here.
    //
    // leaveGroup() returns a Promise (the awaited native teardown of the
    // foreground service / hotspot / TCP listener). On real unmount the JS
    // context survives long enough for it to settle; on hot reload it may
    // not, and the listener can briefly outlive JS — but at least the
    // synchronous prefix (signaling.disconnect + rtc.destroy) always runs
    // before we return, and the native re-bind has its own EADDRINUSE
    // backoff. We swallow the rejection here so it doesn't surface as an
    // unhandled-promise warning during the teardown window.
    try {
      // leaveGroup is always async (declared async in useIntercom). Swallow
      // any rejection so the unmount window doesn't surface an unhandled-
      // promise warning while React tears down.
      leaveGroupRef.current().catch(() => {});
    } catch { /* synchronous throw during teardown — ignore */ }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" />
      {screen === 'home' ? (
        <HomeScreen onHost={handleHost} onJoin={handleJoin} busy={busy} />
      ) : (
        <ErrorBoundary
          onError={() => { /* fall through to onReset for teardown */ }}
          onReset={() => {
            // handleLeave is async; the pre-await prefix (setBusy, setScreen)
            // can throw sync and ErrorBoundary.reset's try/catch only catches
            // sync throws — wrap the promise too so a rejection from the
            // awaited leaveGroup() doesn't surface as unhandled.
            try { handleLeave().catch(() => {}); } catch { /* ignore */ }
          }}
        >
          <GroupScreen
            store={store}
            vox={vox}
            voxEnabled={voxEnabled}
            onToggleVox={() => setVoxEnabled((v) => !v)}
            onMuteToggle={toggleMute}
            onLeave={handleLeave}
          />
        </ErrorBoundary>
      )}
    </SafeAreaProvider>
  );
}

export default App;
