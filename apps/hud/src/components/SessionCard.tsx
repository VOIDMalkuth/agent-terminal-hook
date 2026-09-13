import type { Session, SessionState } from '../store/sessions';
import { STALE_MS } from '../store/sessions';
import { useSettings } from '../store/settings';
import { relTime } from '../lib/time';
import { useDotPhase } from '../lib/anim';
import { cx } from '../lib/cx';

const STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  waiting_input: 'waiting_input',
  review: 'possible approval',
  done: 'done',
};

/** Status dot: green=working, amber=waiting_input (same pulse animation, color only), ✓=done.
 *  A pingKey change injects a one-shot .dot-ping child to replay the pulse ring (op arrival;
 *  waiting_input adds a 3-minute periodic ripple computed in SessionCard). The dot element is
 *  never remounted, but done/stale class swaps kill the breathe animation — useDotPhase
 *  re-locks its phase after every such restart. */
function StatusDot({ state, pingKey }: { state: SessionState; pingKey: string }) {
  const cls = cx('dot', state === 'done' ? 'dot-done' : `dot-${state}`);
  const ref = useDotPhase(cls);
  return (
    <span ref={ref} className={cls}>
      {state === 'done' ? '✓' : pingKey ? <span key={pingKey} className="dot-ping" /> : null}
    </span>
  );
}

/** Op stream: one compact row for the most recent op (tool + summary + relative time), no history.
 *  PreToolUse(start)/PostToolUse(end) pair into one row: spinner while running, ✗ on failure. */
function OpTimeline({ ops, now }: { ops: Session['ops']; now: number }) {
  const last = ops[ops.length - 1];
  if (!last) return null;
  return (
    <div className="ops">
      <div className="ops-last">
        {last.status === 'running' && <span className="op-spin" title="工具执行中" />}
        {last.status === 'failed' && <span className="op-fail">✗</span>}
        <span className="op-tool">{last.tool}</span>
        {last.summary && <span className="op-summary">{last.summary}</span>}
        <span className="hud-spacer" />
        <span className="op-time">{relTime(last.at, now)}</span>
        {ops.length > 1 && (
          <span className="op-more" title="本轮操作数（新一轮交互时清空）">
            +{ops.length - 1}
          </span>
        )}
      </div>
    </div>
  );
}

/** Inline marks: question circle = why; arrow = next (currentColor follows the row) */
function WhyIcon() {
  return (
    <svg
      className="report-mark"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg
      className="report-mark"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function SessionCard({
  s,
  now,
  onDelete,
  onMarkStale,
}: {
  s: Session;
  now: number;
  onDelete: (sid: string) => void;
  onMarkStale: (sid: string) => void;
}) {
  // stale: 1h of silence (STALE_MS) or manual ⚑; both hidden when staleOn is off
  const stale =
    useSettings((st) => st.staleOn) && s.state !== 'done' && (s.staleMarked || now - s.lastAt > STALE_MS);
  const waitingMin = s.waitingSince ? Math.max(1, Math.ceil((now - s.waitingSince) / 60000)) : 0;
  // waiting_input periodic ripple: every waitingNotifyMin minutes (stops when stale)
  const notifyMs = useSettings((st) => st.waitingNotifyMin) * 60_000;
  const waitPing =
    s.state === 'waiting_input' && !stale && s.waitingSince
      ? Math.floor((now - s.waitingSince) / notifyMs)
      : 0;

  return (
    <section
      className={cx('card', `st-${s.state}`, stale && 'is-stale', s.state === 'done' && 'is-done')}
    >
      <div className="card-row">
        <StatusDot state={s.state} pingKey={waitPing ? `w${waitPing}` : s.opPulse ? `o${s.opPulse}` : ''} />
        <span className="card-title" title={s.cwd ?? s.sid}>
          {s.title ?? s.sid}
        </span>
        {s.agent && <span className="chip">{s.agent}</span>}
        {stale && <span className="chip chip-stale">stale</span>}
        <span className="hud-spacer" />
        <span className={cx('state-label', `st-${s.state}`)}>{STATE_LABEL[s.state]}</span>
        {s.state === 'waiting_input' && waitingMin > 0 && (
          <span className="chip chip-wait" title="已等待">
            {waitingMin}m
          </span>
        )}
        {/* ⚑ mark stale / ✕ delete: hover-revealed, pinned once stale (done cards fade anyway) */}
        {s.state !== 'done' && (
          <>
            {!stale && (
              <button
                className="icon-btn card-del"
                title="手动标记 stale（新消息到达自动解除）"
                onClick={() => onMarkStale(s.sid)}
              >
                ⚑
              </button>
            )}
            <button
              className="icon-btn card-del"
              title="删除该会话（同 sid 再来消息会重新显示）"
              onClick={() => onDelete(s.sid)}
            >
              ✕
            </button>
          </>
        )}
      </div>

      {/* done: collapse to the title row (✓) so window height drops immediately; fades after 5s */}
      {s.state !== 'done' && (
        <div className="card-report">
          {s.report ? (
            <>
              <div className="report-summary">{s.report.summary}</div>
              {s.report.reason && (
                <div className="report-sub">
                  <WhyIcon />
                  {s.report.reason}
                </div>
              )}
              {s.report.next && (
                <div className="report-sub">
                  <NextIcon />
                  {s.report.next}
                </div>
              )}
            </>
          ) : (
            <div className="report-empty">{s.cwd ?? '等待 agent 首次自述…'}</div>
          )}
        </div>
      )}

      {s.state !== 'done' && <OpTimeline ops={s.ops} now={now} />}
    </section>
  );
}
