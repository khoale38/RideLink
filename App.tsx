import React, { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'react-native';
import { HomeScreen } from './src/screens/HomeScreen';
import { GroupScreen } from './src/screens/GroupScreen';
import { useGroupStore } from './src/store/groupStore';
import { useIntercom } from './src/hooks/useIntercom';
import { useVOX } from './src/hooks/useVOX';

function App() {
  const store = useGroupStore();
  const { hostGroup, joinGroup, leaveGroup, toggleMute, localStream } = useIntercom(store);
  const [screen, setScreen] = useState<'home' | 'group'>('home');
  const [voxEnabled, setVoxEnabled] = useState(true);

  const vox = useVOX(localStream, screen === 'group' && voxEnabled && !store.muted);

  const handleHost = async (name: string) => {
    setScreen('group');
    await hostGroup(name);
  };

  const handleJoin = async (name: string) => {
    setScreen('group');
    await joinGroup(name);
  };

  const handleLeave = () => {
    leaveGroup();
    setScreen('home');
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" />
      {screen === 'home' ? (
        <HomeScreen onHost={handleHost} onJoin={handleJoin} />
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
