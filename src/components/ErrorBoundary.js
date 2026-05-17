/**
 * Last-line error boundary for the in-ride screens. A throw inside
 * GroupScreen rendering (or a downstream child) would otherwise crash the
 * React tree and leave native resources (foreground service, hotspot,
 * signaling server) running with no way for the user to recover short of
 * force-quit. The boundary routes back to Home and asks the embedding hook
 * to tear the session down.
 *
 * Kept as a class component because React only invokes componentDidCatch
 * lifecycle on class boundaries.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { logger } from '../services/logger';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    logger.error('ErrorBoundary', error, { componentStack: info?.componentStack });
    // Best-effort recovery: tell the parent to tear down the session. The
    // parent owns native resource shutdown — this boundary just renders
    // a fallback so the rider isn't staring at a frozen screen.
    try { this.props.onError?.(error); } catch (_) { /* ignore */ }
  }

  reset = () => {
    // Order matters: fire onReset() FIRST so the parent can swap the screen
    // (which unmounts this boundary entirely). Clearing `error` before the
    // parent reroutes would briefly re-render the still-torn child tree —
    // a render-time crash would re-throw the next tick and put us right
    // back into the error state. The setState below is the fallback for
    // when the parent's reset is purely in-place (no unmount).
    try { this.props.onReset?.(); } catch (_) { /* ignore */ }
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The intercom hit an unexpected error and was stopped to keep your
          ride safe. Tap below to return home and rejoin.
        </Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={this.reset}
          accessibilityRole="button"
          accessibilityLabel="Return to home screen"
        >
          <Text style={styles.btnText}>Return home</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d', padding: 24, justifyContent: 'center' },
  title: { color: '#f5a623', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  body: { color: '#ccc', fontSize: 14, marginBottom: 24, lineHeight: 20 },
  btn: { backgroundColor: '#f5a623', borderRadius: 12, padding: 16, alignItems: 'center' },
  btnText: { color: '#0d0d0d', fontWeight: '700', fontSize: 16 },
});
