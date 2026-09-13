# agents/claude — Claude Code bridge

Lifecycle hooks + ath_report reminder injection for Claude Code. **http transport
only**: claude hooks run without a controlling terminal on every platform (there is
no `/dev/tty` to write) and claude's `terminalSequence` output field whitelists OSC
0/1/2/9/99/777 while explicitly rejecting OSC 1337 — so the codex bridge's
ath-send/tty path cannot exist here. Events are mapped by `hook.mjs` and POSTed
straight to the local gateway (`ATH_URL`, default `http://127.0.0.1:7301/event`).
The mapping is transport-agnostic: an OSC 2 (window-title) carrier — the hook emits
`ATH1:`-prefixed titles via `terminalSequence`, the WezTerm gateway sniffs them in
`format-tab-title` and renders the original title — slots in as an OSC-flavored
last mile without touching the mapping.

## Install (opt-in)

The default installer (`agents/codex/install.mjs`) does NOT touch claude. Install
claude support explicitly:

```
node agents/claude/install.mjs            # install
node agents/claude/install.mjs uninstall  # remove everything this script manages
```

What install does:

1. Deploys `hook.mjs` to a fixed location, `~/.ath/claude/` (existing deployment
   prompts before overwrite; `--yes/-y` skips). The package folder is deletable
   afterwards.
2. Merges 11 hook entries into `~/.claude/settings.json` (exec form `node + args`,
   `Notification` scoped to `idle_prompt`, `SessionEnd` at `timeout: 10` — claude's
   default shared budget is 1.5 s and the bye must fit). Merge-style: only entries
   pointing at the deployed hook path are touched; foreign hooks are preserved.
   A foreign settings.json is backed up to `settings.json.bak.<ts>` first.
3. Writes `env.ATH_TRANSPORT=http` into settings.json unless already set — claude
   has no tty path at all, and the ath-report MCP server (below) reads the same env.

Restart any running claude sessions after installing (hooks and env are read at
startup).

## ath_report self-reporting (optional)

Register the shared MCP server once so the model can call `ath_report`:

```
claude mcp add ath -- node <repo-or-pack>/remote/ath-report-mcp/server.mjs
```

The hook injects the reporting convention on SessionStart and re-nags every 5
minutes via PostToolUse `additionalContext`. State files land in the same directory
the codex bridge uses (`~/.codex/ath_report/`), so the MCP server attributes
claude sids without any change on its side.

## Event mapping

| Claude event | ATH message | Notes |
| --- | --- | --- |
| SessionStart (startup/resume/clear/fork) | register(waiting_input) | `source=compact` ignored (mid-turn continuation) |
| UserPromptSubmit | state working | |
| PreToolUse | op start, key=tool_use_id, input=raw tool_input (≤1.2 kB) | |
| PostToolUse | op end | |
| PostToolUseFailure | op end ok:false | cancelling a running tool fires no hook, so `is_interrupt` is not dependable |
| PermissionRequest | review | fires only when claude actually prompts the user — unambiguous, unlike codex; no `tool_use_id` in its input |
| PermissionDenied | op end ok:false | denied calls fire no Post* event; without this the op spinner hangs |
| Stop | state waiting_input | not fired when the user interrupts |
| StopFailure | state waiting_input | turn ended by an API error |
| Notification (idle_prompt) | state waiting_input | ~60 s-delayed fallback: interrupts fire no hook at all |
| SessionEnd | bye | hook entry installed with `timeout: 10` |

Everything else (Setup, subagents, tasks, model-switch, elicitation, ...) is
ignored; subagent tool events carry the same session_id and fold into the
session's op stream.
