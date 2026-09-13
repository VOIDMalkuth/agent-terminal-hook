/** Receiver-side op display formatting: the protocol keeps the raw tool input
 *  (op.input) and presentation rules live here, so they evolve with the HUD —
 *  no agent-side redeploy needed. First matching rule wins; a rule whose input
 *  shape it cannot handle returns undefined and falls through to the raw
 *  fallback — supported tools get rewritten, everything else displays as-is.
 *  Future agents (claude) extend RULES; their hooks only carry op.input. */

const SUMMARY_MAX = 80; // display budget (mirrors the old sender-side compact())

function trunc(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

/** mcp__<server>__<tool> -> <server>:<tool>; anything else unchanged */
function shortMcp(tool: string): string {
  const parts = tool.split('__');
  return parts[0] === 'mcp' && parts.length >= 3 ? `${parts[1]}:${parts.slice(2).join('__')}` : tool;
}

/** shell command out of the tool input: a string (Bash) or an argv array (codex shell) */
function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const c = (input as { command?: unknown }).command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return undefined;
}

interface OpDisplay {
  tool?: string;
  summary?: string;
}

const RULES: Array<{
  match: (tool: string) => boolean;
  render: (tool: string, input: unknown) => OpDisplay | undefined;
}> = [
  // MCP calls: <server>:<tool> reads better; the JSON body stays in the CLI
  {
    match: (t) => t.startsWith('mcp__'),
    render: (t) => ({ tool: shortMcp(t), summary: undefined }),
  },
  // shell: the command line is the whole story, the JSON wrapper is noise
  {
    match: (t) => /^(bash|shell)$/i.test(t),
    render: (_t, input) => {
      const cmd = commandOf(input);
      return cmd === undefined ? undefined : { summary: cmd };
    },
  },
];

export function formatOp(tool: string, input: unknown): { tool: string; summary?: string } {
  for (const rule of RULES) {
    if (!rule.match(tool)) continue;
    const out = rule.render(tool, input);
    if (out) {
      return {
        tool: out.tool ?? tool,
        summary: out.summary === undefined ? undefined : trunc(out.summary),
      };
    }
  }
  // unsupported tool: raw input — plain strings verbatim (senders may pass ready
  // text, e.g. failure notes), anything else JSON-printed; truncated to the budget
  if (input === undefined) return { tool };
  return { tool, summary: trunc(typeof input === 'string' ? input : JSON.stringify(input)) };
}
