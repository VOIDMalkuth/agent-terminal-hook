import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DockSide } from '../lib/window';

export interface SettingsState {
  /** outer shell opacity 0.35 ~ 1 */
  opacity: number;
  /** session card opacity 0.35 ~ 1 (independent of the shell) */
  cardOpacity: number;
  /** color theme: dark (default) / light */
  theme: 'dark' | 'light';
  alwaysOnTop: boolean;
  /** local beep when a session enters waiting_input (incl. turn end) */
  soundOnWaiting: boolean;
  /** stale chip toggle: gray "stale" chip after >1h of silence; default on */
  staleOn: boolean;
  /** runtime only: collapsed to the edge strip (not persisted; starts minimized,
   *  auto-expands when the first session arrives) */
  collapsed: boolean;
  /** strip dock side: nearest work-area edge by window center after a drag; persisted */
  dockSide: DockSide;
  patch: (p: Partial<Omit<SettingsState, 'patch'>>) => void;
}

/** Window position is not persisted: startup docks to the primary monitor edge;
 *  the tray menu can reset it. */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      opacity: 0.96,
      cardOpacity: 1,
      theme: 'dark',
      alwaysOnTop: true,
      soundOnWaiting: true,
      staleOn: true,
      collapsed: true,
      dockSide: 'right',
      patch: (p) => set(p),
    }),
    {
      name: 'ath-hud-settings',
      version: 4,
      partialize: (s) => ({
        opacity: s.opacity,
        cardOpacity: s.cardOpacity,
        theme: s.theme,
        alwaysOnTop: s.alwaysOnTop,
        soundOnWaiting: s.soundOnWaiting,
        staleOn: s.staleOn,
        dockSide: s.dockSide,
      }),
      // v4: stale defaults to on — one-time flip of a persisted false to true
      migrate: (legacy) => {
        const s = (legacy ?? {}) as Record<string, unknown>;
        return {
          opacity: typeof s.opacity === 'number' ? s.opacity : 0.96,
          cardOpacity: typeof s.cardOpacity === 'number' ? s.cardOpacity : 1,
          theme: s.theme === 'light' ? ('light' as const) : ('dark' as const),
          alwaysOnTop: s.alwaysOnTop !== false,
          soundOnWaiting: s.soundOnWaiting !== false,
          staleOn: true,
          dockSide:
            s.dockSide === 'left' || s.dockSide === 'right' || s.dockSide === 'top' || s.dockSide === 'bottom'
              ? s.dockSide
              : ('right' as DockSide),
        };
      },
    },
  ),
);
