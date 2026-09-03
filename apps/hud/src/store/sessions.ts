import { create } from 'zustand';
import type { AthMessage, SessionState } from '@ath/protocol';
import { useSettings } from './settings';
import { playBeep } from '../lib/sound';

export const STALE_MS = 60 * 60 * 1000; // >1h without any message -> stale chip (design.md §2.3)
/** waiting_input periodic ripple: every 3 minutes, stops once stale */
export const WAITING_PING_MS = 180_000;
/** register race window: with SessionStart/UserPromptSubmit hooks firing
 *  concurrently, a late register must not flip a working card */
const REGISTER_RACE_MS = 5_000;
export type { SessionState };
export const DONE_FADE_MS = 6000; // 5s hold + 1s fade before removal; keep in sync with card-fade in global.css
const OPS_LIMIT = 60;

export interface OpEntry {
  tool: string;
  summary?: string;
  at: number;
  /** PreToolUse(start)/PostToolUse(end) pairing key (toolCallId); falls back to same-tool FIFO */
  key?: string;
  /** start=running; done/failed=closed; undefined=instant event (no pairing) */
  status?: 'running' | 'done' | 'failed';
  /** paired duration in ms */
  ms?: number;
}

export interface ReportEntry {
  summary: string;
  reason?: string;
  next?: string;
  at: number;
}

export interface Session {
  sid: string;
  host?: string;
  cwd?: string;
  agent?: string;
  title?: string;
  state: SessionState;
  report?: ReportEntry;
  /** tool-call timeline, old->new, ring-truncated to OPS_LIMIT */
  ops: OpEntry[];
  /** incremented per op arrival; drives the status-dot pulse */
  opPulse: number;
  lastAt: number;
  startedAt: number;
  waitingSince?: number;
  doneAt?: number;
  /** manual stale (⚑ button); any new message clears it (session is alive again) */
  staleMarked?: boolean;
  /** PermissionRequest seen: session stays working; tick() flips the state to
   *  `review` (yellow "possible approval") once this lingers past the
   *  user-configured timeout. Any op arrival or explicit state clears it. */
  pendingReview?: { tool: string; key?: string; at: number };
}

interface SessionsState {
  now: number;
  sessions: Record<string, Session>;
  apply: (msg: AthMessage) => void;
  remove: (sid: string) => void;
  markStale: (sid: string) => void;
  tick: () => void;
  clear: () => void;
}

function pushOp(ops: OpEntry[], entry: OpEntry): OpEntry[] {
  return [...ops, entry].slice(-OPS_LIMIT);
}

/** Index of the last running, pairable op: by key (toolCallId) when present, else same-tool FIFO */
function lastRunningIndex(ops: OpEntry[], key: string | undefined, tool: string): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.status !== 'running') continue;
    if (key ? o.key === key : o.tool === tool) return i;
  }
  return -1;
}

/** Fold an incoming message into the session map; op arrival implies working
 *  (a tool is executing), report only refreshes the self-description + stale clock */
function applyMessage(sessions: Record<string, Session>, msg: AthMessage): Record<string, Session> {
  // local arrival time everywhere: remote clock skew must not affect stale/waiting timers
  const now = Date.now();
  const prev = sessions[msg.sid];
  const s: Session = {
    sid: msg.sid,
    // identity fields may ride on any message: senders that attach title/cwd to
    // every message let the HUD rebuild the full card from the first one after a restart
    host: msg.host ?? prev?.host,
    cwd: msg.cwd ?? prev?.cwd,
    agent: msg.agent ?? prev?.agent,
    title: msg.title ?? prev?.title,
    state: prev?.state ?? 'working',
    report: prev?.report,
    ops: prev?.ops ?? [],
    opPulse: prev?.opPulse ?? 0,
    lastAt: now,
    startedAt: prev?.startedAt ?? now,
    waitingSince: prev?.waitingSince,
    doneAt: prev?.doneAt,
    pendingReview: prev?.pendingReview,
    // staleMarked is not inherited: any new message = signs of life = manual stale clears
    staleMarked: undefined,
  };

  switch (msg.type) {
    case 'register':
      // A new task registers as waiting_input (design.md §2.3); register may carry an
      // explicit state. But SessionStart and UserPromptSubmit are concurrent async hooks
      // and register can arrive ~13ms after working, flashing a working card back to
      // waiting — within REGISTER_RACE_MS of the previous message only refresh identity
      // fields; later registers (resume/clear of the same session) still reset to waiting.
      // Registration does not beep.
      if (!prev || s.state === 'done' || now - prev.lastAt > REGISTER_RACE_MS) {
        s.state = msg.state ?? 'waiting_input';
        s.waitingSince = s.state === 'waiting_input' ? now : undefined;
        s.doneAt = undefined;
        s.pendingReview = undefined;
      }
      break;

    case 'state':
      if (msg.state) {
        const prevState = s.state;
        s.state = msg.state;
        // a new turn (->working, fresh user input) clears the op stream: +N counts this turn
        if (msg.state === 'working' && prevState !== 'working') {
          s.ops = [];
        }
        s.waitingSince = msg.state === 'waiting_input' ? (s.waitingSince ?? now) : undefined;
        s.doneAt = msg.state === 'done' ? (s.doneAt ?? now) : undefined;
        // an explicit state change (turn end, new turn) supersedes a pending approval
        s.pendingReview = undefined;
      }
      break;

    case 'op':
      if (msg.op) {
        const op = msg.op;
        if (op.phase === 'end') {
          const i = lastRunningIndex(s.ops, op.key, op.tool);
          if (i >= 0) {
            // paired with its start: close in place, record duration, no new entry
            const next = s.ops.slice();
            next[i] = {
              ...next[i],
              status: op.ok === false ? 'failed' : 'done',
              ms: now - next[i].at,
            };
            s.ops = next;
          } else {
            // start never arrived (HUD reconnected mid-run / dropped hook): close standalone
            s.ops = pushOp(s.ops, {
              tool: op.tool,
              summary: op.summary,
              at: now,
              status: op.ok === false ? 'failed' : 'done',
            });
          }
        } else if (op.phase === 'start') {
          s.ops = pushOp(s.ops, {
            tool: op.tool,
            summary: op.summary,
            at: now,
            status: 'running',
            ...(op.key ? { key: op.key } : {}),
          });
        } else {
          // no phase: instant event (mock script / legacy senders)
          s.ops = pushOp(s.ops, { tool: op.tool, summary: op.summary, at: now });
        }
        // op = a tool is executing: back to working (e.g. approved permission), ends wait/done;
        // any op arrival also clears a pending approval (the tool either ran or was replaced)
        s.state = 'working';
        s.waitingSince = undefined;
        s.doneAt = undefined;
        s.pendingReview = undefined;
        s.opPulse += 1;
      }
      break;

    case 'review':
      if (msg.review) {
        // PermissionRequest: ambiguous under auto-review (identical event for human and
        // reviewer) — keep working; tick() flips to `review` past the configured timeout
        s.pendingReview = {
          tool: msg.review.tool,
          ...(msg.review.key ? { key: msg.review.key } : {}),
          at: now,
        };
      }
      break;

    case 'report':
      if (msg.report) {
        s.report = {
          summary: msg.report.summary,
          reason: msg.report.reason,
          next: msg.report.next,
          at: now,
        };
      }
      break;

    case 'bye':
      s.state = 'done';
      s.doneAt = now;
      s.waitingSince = undefined;
      s.pendingReview = undefined;
      break;

    default:
      break;
  }

  return { ...sessions, [msg.sid]: s };
}

export const useSessions = create<SessionsState>((set, get) => ({
  now: Date.now(),
  sessions: {},

  apply: (msg) => {
    // waiting_input is the highest-value state: optional beep on first entry (design.md §5.2)
    if (msg.type === 'state' && msg.state === 'waiting_input') {
      const prev = get().sessions[msg.sid];
      if ((!prev || prev.state !== 'waiting_input') && useSettings.getState().soundOnWaiting) {
        playBeep();
      }
    }
    set((st) => ({ sessions: applyMessage(st.sessions, msg) }));
  },

  // manual delete (mainly for stale sessions without bye); local only — the same sid reappears on its next message
  remove: (sid) =>
    set((st) => {
      if (!(sid in st.sessions)) return st;
      const sessions = { ...st.sessions };
      delete sessions[sid];
      return { sessions };
    }),

  // manual stale (⚑): display-only, new messages clear it automatically
  markStale: (sid) =>
    set((st) => {
      const s = st.sessions[sid];
      if (!s || s.staleMarked) return st;
      return { sessions: { ...st.sessions, [sid]: { ...s, staleMarked: true } } };
    }),

  tick: () =>
    set((st) => {
      const now = Date.now();
      let removed = false;
      let changed = false;
      const sessions: Record<string, Session> = {};
      const reviewMs = useSettings.getState().reviewTimeoutSec * 1000;
      for (const [sid, s] of Object.entries(st.sessions)) {
        if (s.state === 'done' && s.doneAt !== undefined && now - s.doneAt > DONE_FADE_MS) {
          removed = true;
          continue;
        }
        // a pending approval that outlives the timeout becomes a yellow "possible approval"
        if (s.pendingReview && s.state === 'working' && now - s.pendingReview.at >= reviewMs) {
          sessions[sid] = { ...s, state: 'review', pendingReview: undefined };
          changed = true;
          continue;
        }
        sessions[sid] = s;
      }
      if (removed || changed) return { now, sessions };
      return { now };
    }),

  clear: () => set({ sessions: {} }),
}));

/** waiting_input first, then possible approval, then working, then done; recency within a rank */
export function sortSessions(list: Session[], _now: number): Session[] {
  const rank = (s: Session) =>
    s.state === 'waiting_input' ? 0 : s.state === 'review' ? 1 : s.state === 'working' ? 2 : 3;
  return [...list].sort((a, b) => rank(a) - rank(b) || b.lastAt - a.lastAt);
}
