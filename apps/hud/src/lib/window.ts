import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  Monitor,
  PhysicalPosition,
} from '@tauri-apps/api/window';
import { isTauri } from './tauri';

/** Collapsed strip: docked left/right it is a vertical bar (width STRIP_W),
 *  top/bottom a horizontal bar (height STRIP_H). Long side = grip + separator
 *  + dot row; dot pitch 28 (22px dot + 6 gap), trailing 48 keeps end padding
 *  tight. Window size = pill size + CHROME: 2x4px collapsed root padding +
 *  2px card border — without this margin the pill gets squashed (the expanded
 *  measurement formula has always included the same margin). */
const CHROME = 10;
export const STRIP_W = 30;
export const STRIP_H = 30;
export const stripLong = (dots: number): number => 28 * Math.max(dots, 1) + 48;

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

export const isSideVertical = (side: DockSide): boolean => side === 'left' || side === 'right';

/** Window size for a dock side + dot count (both orientations, chrome included) */
export function stripDims(side: DockSide, dots: number): { w: number; h: number } {
  return isSideVertical(side)
    ? { w: STRIP_W + CHROME, h: stripLong(dots) + CHROME }
    : { w: stripLong(dots) + CHROME, h: STRIP_H + CHROME };
}

export async function setHudSize(width: number, height: number): Promise<void> {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().setSize(new LogicalSize(width, height));
  } catch {
    // resize can fail on permissions/timing — non-fatal
  }
}

/**
 * Snap one window edge flush to the monitor work area. The other axis keeps the
 * current position (clamped into the work area), or with alignStart lands at a
 * fixed RESET_INSET from the work-area origin — used by startup/reset where a
 * deterministic position is wanted. The collapsed strip and "grow out of the
 * edge" expansion share this; position is pre-computed for the target size so
 * the window always grows inward.
 */
export const RESET_INSET = 48;

export async function snapHudEdge(
  width: number,
  height: number,
  side: DockSide,
  mon?: Monitor | null,
  alignStart = false,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const win = getCurrentWindow();
    const m = mon ?? (await currentMonitor());
    if (!m) return setHudSize(width, height);
    const scale = m.scaleFactor || 1;
    const wPhys = Math.round(width * scale);
    const hPhys = Math.round(height * scale);
    const wa = m.workArea;
    const pos = await win.outerPosition();
    let x: number;
    if (side === 'left') {
      x = wa.position.x;
    } else if (side === 'right') {
      x = wa.position.x + wa.size.width - wPhys;
    } else {
      // top/bottom: flush vertically, keep current x or land at start inset (clamped)
      const startX = wa.position.x + Math.round(RESET_INSET * scale);
      x = alignStart ? startX : pos.x;
      x = Math.min(Math.max(x, wa.position.x), wa.position.x + wa.size.width - wPhys);
    }
    const startY = wa.position.y + Math.round(RESET_INSET * scale);
    const y =
      side === 'top'
        ? wa.position.y
        : side === 'bottom'
          ? wa.position.y + wa.size.height - hPhys
          : Math.min(
              Math.max(alignStart ? startY : pos.y, wa.position.y),
              wa.position.y + wa.size.height - hPhys,
            );
    // Skip setPosition when already at target (±2px): snapping triggers onMoved,
    // and re-snapping on every event would loop
    if (Math.abs(pos.x - x) > 2 || Math.abs(pos.y - y) > 2) {
      await win.setPosition(new PhysicalPosition(x, y));
    }
    await win.setSize(new LogicalSize(width, height));
  } catch {
    // snap failed — degrade to resize only
    await setHudSize(width, height);
  }
}

/** After a drag ends: dock to the work-area edge closest to the window center. */
export async function snapStripAuto(dots: number): Promise<DockSide | null> {
  if (!isTauri()) return null;
  try {
    const win = getCurrentWindow();
    const mon = await currentMonitor();
    if (!mon) return null;
    const wa = mon.workArea;
    const pos = await win.outerPosition();
    const inner = await win.innerSize();
    const cx = pos.x + inner.width / 2;
    const cy = pos.y + inner.height / 2;
    const cands: Array<[DockSide, number]> = [
      ['left', cx - wa.position.x],
      ['right', wa.position.x + wa.size.width - cx],
      ['top', cy - wa.position.y],
      ['bottom', wa.position.y + wa.size.height - cy],
    ];
    cands.sort((a, b) => a[1] - b[1]);
    const side = cands[0][0];
    const { w, h } = stripDims(side, dots);
    await snapHudEdge(w, h, side, mon);
    return side;
  } catch {
    return null;
  }
}
