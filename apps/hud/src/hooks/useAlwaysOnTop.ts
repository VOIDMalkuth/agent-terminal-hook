import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '../lib/tauri';
import { useSettings } from '../store/settings';

export function useAlwaysOnTop(): void {
  const alwaysOnTop = useSettings((s) => s.alwaysOnTop);
  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWindow()
      .setAlwaysOnTop(alwaysOnTop)
      .catch(() => {});
  }, [alwaysOnTop]);
}
