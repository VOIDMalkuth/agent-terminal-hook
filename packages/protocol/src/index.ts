import { z } from 'zod';

/**
 * ATH v1 protocol (design.md §2).
 *
 * Carrier: OSC 1337 SetUserVar=ATH=<base64(JSON)>, written to the TTY by the
 * remote ath-send; the WezTerm Lua gateway (gateway/wezterm) decodes/reassembles
 * and POSTs to the local ath-hud. This package is the single source of truth for
 * message shapes: HUD validation, the mock script and demos all import from here.
 *
 * Note: unlike early design drafts there is no action channel — the HUD is
 * display-only, agents never trigger popups/clipboard/links.
 */

export const STATE_VALUES = ['working', 'waiting_input', 'review', 'done'] as const;
export type SessionState = (typeof STATE_VALUES)[number];

export const MESSAGE_TYPES = ['register', 'state', 'op', 'review', 'report', 'bye'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const AthMessageSchema = z.object({
  v: z.literal(1),
  type: z.enum(MESSAGE_TYPES),
  /**
   * Session aggregation key, recommended `<agent>:<CLI session uuid>` — usually
   * the session_id already present in each CLI hook's stdin (Claude Code / Codex),
   * stable across tmux detach/reattach. The HUD merges cards by it, in memory only.
   */
  sid: z.string().min(1),
  host: z.string().optional(),
  cwd: z.string().optional(),
  /** agent identifier: any string (claude / codex / omp / zcode / ...), not an enum */
  agent: z.string().optional(),
  /** session title: required on register; recommended on every message (a HUD restart
   *  rebuilds the full card from the first message that arrives) */
  title: z.string().optional(),
  /** for type=state; register may also carry it as the initial state (defaults to waiting_input) */
  state: z.enum(STATE_VALUES).optional(),
  /** type=op — tool-level call stream (mechanically produced by hooks, high frequency) */
  op: z
    .object({
      tool: z.string().min(1),
      summary: z.string().optional(),
      /** pairing key for PreToolUse(start)/PostToolUse(end) (e.g. toolCallId; HUD pairs same-tool FIFO otherwise) */
      key: z.string().optional(),
      /** start=running; end=closing. Missing phase means an instant event */
      phase: z.enum(['start', 'end']).optional(),
      /** only meaningful on end: false = failed */
      ok: z.boolean().optional(),
    })
    .optional(),
  /** type=review — PermissionRequest seen. The HUD keeps the session working and
   *  only flips to a yellow "possible approval" if the mark lingers past the
   *  user-configured timeout (auto-review must not flash waiting_input) */
  review: z
    .object({
      tool: z.string().min(1),
      /** tool_use_id of the pending approval; a matching op end clears the mark */
      key: z.string().optional(),
    })
    .optional(),
  /** type=report — model's high-level self-description (ath_report MCP, low frequency) */
  report: z
    .object({
      summary: z.string().min(1),
      reason: z.string().optional(),
      next: z.string().optional(),
    })
    .optional(),
  ts: z.number().optional(),
});

export type AthMessage = z.infer<typeof AthMessageSchema>;

/** Lenient parse: returns null on invalid input (HUD drops unknown/malformed messages silently) */
export function parseAthMessage(raw: unknown): AthMessage | null {
  const r = AthMessageSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Fragment envelope (reserved capability, design.md §2.1): messages over ~1.5KB
 * are wrapped in {v,id,seq,tot,data} where data is a base64 fragment of the
 * inner JSON; the gateway buffers by id until complete.
 */
export interface FragmentEnvelope {
  v: 1;
  id: string;
  seq: number;
  tot: number;
  data: string;
}

export function isFragmentEnvelope(raw: unknown): raw is FragmentEnvelope {
  return z
    .object({
      v: z.literal(1),
      id: z.string().min(1),
      seq: z.number().int().min(1),
      tot: z.number().int().min(2),
      data: z.string().min(1),
    })
    .safeParse(raw).success;
}
