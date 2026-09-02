import { useEffect } from 'react';
import { HudRoot } from './components/HudRoot';
import { useAthEvents } from './hooks/useAthEvents';
import { useWindowPersistence } from './hooks/useWindowPersistence';
import { useAlwaysOnTop } from './hooks/useAlwaysOnTop';
import { useSessions } from './store/sessions';
import { useSettings } from './store/settings';

export default function App() {
  useAthEvents();
  useWindowPersistence();
  useAlwaysOnTop();

  // theme switch: write <html data-theme>
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 1Hz clock: drives stale chips, waiting timers, done fade-out collection
  useEffect(() => {
    const t = window.setInterval(() => useSessions.getState().tick(), 1000);
    return () => window.clearInterval(t);
  }, []);

  return <HudRoot />;
}
