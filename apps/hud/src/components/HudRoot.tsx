import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useSessions, sortSessions, STALE_MS, type Session } from '../store/sessions';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { isTauri } from '../lib/tauri';
import { useDotPhase } from '../lib/anim';
import { cx } from '../lib/cx';
import { setHudSize, snapHudEdge, stripDims } from '../lib/window';
import { SessionCard } from './SessionCard';
import { SettingsPanel } from './SettingsPanel';

const EXPANDED_WIDTH = 380;
// expanded min height ~= one minimal card (title row only); everything else adapts to content
const EXPANDED_MIN_H = 140;

function CollapsedDot({ s, now }: { s: Session; now: number }) {
  const stale =
    useSettings((st) => st.staleOn) && s.state !== 'done' && (s.staleMarked || now - s.lastAt > STALE_MS);
  const label = `${s.title ?? s.sid} · ${s.state}${stale ? ' · stale' : ''}`;
  // waiting_input ripple every waitingNotifyMin minutes (stops when stale), same cadence as the card
  const notifyMs = useSettings((st) => st.waitingNotifyMin) * 60_000;
  const waitPing =
    s.state === 'waiting_input' && !stale && s.waitingSince
      ? Math.floor((now - s.waitingSince) / notifyMs)
      : 0;
  const cls = cx(
    'dot dot-big',
    s.state === 'done' ? 'dot-done' : `dot-${s.state}`,
    stale && 'dot-stale',
  );
  const ref = useDotPhase(cls);
  // The button carries a bare drag-region: edges drag, clicking the visible dot center
  // bubbles up to the strip and expands
  return (
    <button className="dot-btn" data-tauri-drag-region title={label}>
      <span ref={ref} className={cls}>
        {s.state === 'done' ? '✓' : waitPing > 0 ? <span key={waitPing} className="dot-ping" /> : null}
      </span>
    </button>
  );
}

function EmptyState() {
  const gateway = useUi((s) => s.gateway);
  return (
    <div className="empty">
      <div className="empty-glyph">
        <span className="mark-empty mark-empty-lg" />
      </div>
      <div className="empty-title">暂无会话</div>
      <div className="dim">
        接入网关：<code>127.0.0.1:{gateway?.port ?? 7301}</code>
      </div>
      {gateway && !gateway.bound && (
        <div className="empty-warn">网关未监听：{gateway.error ?? '端口被占用？'}</div>
      )}
    </div>
  );
}

export function HudRoot() {
  const sessions = useSessions((s) => s.sessions);
  const now = useSessions((s) => s.now);
  const settings = useSettings();
  const settingsOpen = useUi((s) => s.settingsOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const list = sortSessions(Object.values(sessions), now);
  const mainRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastHeightRef = useRef(0);
  const prevCountRef = useRef(0);

  // Collapsed: window snaps to the edge as a strip (side remembered in settings.dockSide);
  // strip length follows the session count
  useEffect(() => {
    if (settings.collapsed && isTauri()) {
      const { w, h } = stripDims(settings.dockSide, list.length);
      void snapHudEdge(w, h, settings.dockSide);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.collapsed, list.length, settings.dockSide]);

  // Starts minimized: the first session auto-expands (growing inward from the docked edge);
   // when the last session disappears the strip returns
  useEffect(() => {
    if (prevCountRef.current === 0 && list.length > 0 && settings.collapsed) {
      useSettings.getState().patch({ collapsed: false });
      lastHeightRef.current = 0;
      void snapHudEdge(EXPANDED_WIDTH, EXPANDED_MIN_H, settings.dockSide);
    }
    if (prevCountRef.current > 0 && list.length === 0 && !settings.collapsed) {
      useSettings.getState().patch({ collapsed: true });
      lastHeightRef.current = 0;
      const { w, h } = stripDims(settings.dockSide, 0);
      void snapHudEdge(w, h, settings.dockSide);
    }
    prevCountRef.current = list.length;
  }, [list.length, settings.collapsed, settings.dockSide]);

  // Expanded: window height follows content; done (single row) and removed sessions drop it
  // immediately. Measure the content wrapper's natural height (a flex-stretched container is
  // only ever >= window height, so it would grow but never shrink). Do not measure height
  // until width is back to EXPANDED_WIDTH — text rewraps in a narrow window and inflates
  // the measurement (root cause of the old "grow to max then shrink" jitter).
  const measure = useCallback(() => {
    if (!isTauri() || useSettings.getState().collapsed) return;
    const main = mainRef.current;
    const content = contentRef.current;
    if (!main || !content) return;
    if (window.innerWidth < EXPANDED_WIDTH - 4) return;
    const headerH = (main.previousElementSibling as HTMLElement | null)?.offsetHeight ?? 0;
    let target = content.scrollHeight + headerH + 50; // body padding 28 + root padding 20 + border 2
    const panel = panelRef.current;
    if (useUi.getState().settingsOpen && panel) {
      target = Math.max(target, panel.scrollHeight + 68); // root padding+border 22 + panel top 36 + bottom 10
    }
    const clamped = Math.max(
      EXPANDED_MIN_H,
      Math.min(Math.ceil(target), Math.floor(window.screen.height * 0.85)),
    );
    if (Math.abs(clamped - lastHeightRef.current) > 2) {
      lastHeightRef.current = clamped;
      void setHudSize(EXPANDED_WIDTH, clamped);
    }
  }, []);

  useEffect(() => {
    measure();
  });
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const toggleCollapse = () => {
    const next = !settings.collapsed;
    settings.patch({ collapsed: next });
    if (!next) {
      // Expand by growing inward from the docked edge: restore last height first (min height
      // if none) to avoid a flash; the measurement pass then settles it precisely
      void snapHudEdge(EXPANDED_WIDTH, Math.max(lastHeightRef.current, EXPANDED_MIN_H), settings.dockSide);
    }
  };

  return (
    <div className={cx('hud-root', settings.collapsed && 'is-collapsed')}>
      <div
        className={cx('hud-card', settings.collapsed && 'is-collapsed')}
        style={
          {
            '--hud-alpha': settings.opacity,
            '--card-alpha': settings.cardOpacity,
          } as CSSProperties
        }
      >
        <header className="hud-header" data-tauri-drag-region>
          <span className="hud-grip" data-tauri-drag-region>
            ⠿
          </span>
          <span className="hud-title" data-tauri-drag-region>
            agent sessions
          </span>
          {list.length > 0 && <span className="hud-count">{list.length}</span>}
          <span className="hud-spacer" data-tauri-drag-region />
          {!settings.collapsed && (
            <>
              <button
                className={cx('icon-btn', settingsOpen && 'active')}
                title="设置"
                onClick={() => setSettingsOpen(!settingsOpen)}
              >
                ⚙
              </button>
              <button className="icon-btn" title="收起为贴边细条" onClick={toggleCollapse}>
                ▾
              </button>
            </>
          )}
        </header>

        {settings.collapsed ? (
          // The strip itself is a deep drag region (blank areas/gaps/button edges all drag);
          // only the exact center of a dot or the empty capsule (elements without the drag
          // attribute) bubbles up as a click to expand
          <main
            className={cx(
              'hud-strip',
              settings.dockSide !== 'left' && settings.dockSide !== 'right' && 'is-h',
            )}
            data-tauri-drag-region="deep"
            title="点圆点中心展开，其余位置拖动"
            onClick={toggleCollapse}
          >
            <span className="hud-strip-grip" data-tauri-drag-region>
              ⠿
            </span>
            <span className="hud-strip-sep" />
            <div className="hud-strip-dots">
              {list.length === 0 ? (
                <span className="mark-empty" data-tauri-drag-region="false" />
              ) : (
                list.map((s) => <CollapsedDot key={s.sid} s={s} now={now} />)
              )}
            </div>
          </main>
        ) : (
          <main className="hud-body" ref={mainRef}>
            <div className="hud-body-inner" ref={contentRef}>
              {list.length === 0 ? (
                <EmptyState />
              ) : (
                list.map((s) => (
                  <SessionCard
                    key={s.sid}
                    s={s}
                    now={now}
                    onDelete={(sid) => useSessions.getState().remove(sid)}
                    onMarkStale={(sid) => useSessions.getState().markStale(sid)}
                  />
                ))
              )}
            </div>
          </main>
        )}

        {settingsOpen && <SettingsPanel panelRef={panelRef} />}
      </div>
    </div>
  );
}
