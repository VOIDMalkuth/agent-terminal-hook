import { useEffect } from 'react';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { isTauri } from '../lib/tauri';
import { DockSide, snapHudEdge, snapStripAuto, stripDims } from '../lib/window';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';

/** Startup: dock to the primary monitor edge; reset ignores the previous side
 *  and always docks right, RESET_INSET (48px) below the work-area top
 *  (collapsed mode restores the strip shape). */
async function dockToPrimary(forceSide?: DockSide): Promise<void> {
  const mon = await primaryMonitor().catch(() => null);
  if (!mon) return;
  const st = useSettings.getState();
  const side = forceSide ?? st.dockSide;
  if (forceSide && forceSide !== st.dockSide) st.patch({ dockSide: forceSide });
  const n = Object.keys(useSessions.getState().sessions).length;
  if (st.collapsed) {
    const { w, h } = stripDims(side, n);
    await snapHudEdge(w, h, side, mon, true);
  } else {
    await snapHudEdge(window.innerWidth, window.innerHeight, side, mon, true);
  }
}

/** Window placement: dock to the primary monitor edge on startup (no
 *  cross-restart position memory); after dragging the collapsed strip, snap to
 *  the nearest work-area edge by window center. The tray "reset position" item
 *  routes here too (the Rust menu only emits an event; geometry lives in the
 *  frontend). */
export function useWindowPersistence(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let cancelled = false;

    void dockToPrimary();

    const unReset = win.listen('ath-hud-reset-position', () => {
      void dockToPrimary('right');
    });

    let timer = 0;
    const unMoved = win.onMoved(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (cancelled || !useSettings.getState().collapsed) return;
        const n = Object.keys(useSessions.getState().sessions).length;
        void snapStripAuto(n).then((side) => {
          if (side) useSettings.getState().patch({ dockSide: side });
        });
      }, 250);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void unReset.then((f) => f());
      void unMoved.then((f) => f());
    };
  }, []);
}
