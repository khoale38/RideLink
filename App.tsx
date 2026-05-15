import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Alert, StatusBar } from 'react-native';
import KeepAwake from 'react-native-keep-awake';
import { HomeScreen } from './src/screens/HomeScreen';
import { GroupScreen } from './src/screens/GroupScreen';
import { useGroupStore } from './src/store/groupStore';
import { useIntercom } from './src/hooks/useIntercom';
import { useVOX } from './src/hooks/useVOX';

function App() {
  const store = useGroupStore();
  const { hostGroup, joinGroup, leaveGroup, toggleMute, localStream, localLevelRef } = useIntercom(store);
  const [screen, setScreen] = useState<'home' | 'group'>('home');
  const [voxEnabled, setVoxEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  const vox = useVOX(localStream, screen === 'group' && voxEnabled && !store.muted, localLevelRef);

  // Single source of truth for whether the mic audio track is transmitting.
  // - muted: never transmit
  // - VOX off: always transmit
  // - VOX on: transmit only while VOX gate is open (vox.speaking)
  useEffect(() => {
    const track = (localStream as any)?.getAudioTracks?.()[0];
    if (!track) return;
    const desired = screen === 'group' && !store.muted && (!voxEnabled || vox.transmit);
    if (track.enabled !== desired) track.enabled = desired;
  }, [localStream, screen, store.muted, voxEnabled, vox.transmit]);

  const handleHost = async (name: string, password: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await hostGroup(name, password);
      setScreen('group');
    } catch (err: any) {
      leaveGroup();
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
      leaveGroup();
      Alert.alert('Could not join group', err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = () => {
    leaveGroup();
    setScreen('home');
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
    // Defer so the store's setState calls inside leaveGroup don't run during
    // unmount of this tree (which would log a React warning).
    const fn = leaveGroupRef.current;
    setTimeout(() => { try { fn(); } catch (_) { /* ignore */ } }, 0);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" />
      {screen === 'home' ? (
        <HomeScreen onHost={handleHost} onJoin={handleJoin} busy={busy} />
      ) : (
        <GroupScreen
          store={store}
          vox={vox}
          voxEnabled={voxEnabled}
          onToggleVox={() => setVoxEnabled((v) => !v)}
          onMuteToggle={toggleMute}
          onLeave={handleLeave}
        />
      )}
    </SafeAreaProvider>
  );
}

export default App;
