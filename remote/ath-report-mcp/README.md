# ath-report-mcp — model self-report MCP server (Codex)

A stdio MCP server exposing one tool:

```
ath_report(action, reason?, next?, sid?)
  action = what is being done now (required) -> HUD report.summary
  reason = why / on what grounds           -> report.reason
  next   = what comes next                 -> report.next
  sid    = session id echoed from the injected prompt -> attribution
```

On each call it assembles an ATH v1 `report` message and forwards it through
`../ath-send` to `/dev/tty` (OSC 1337 -> WezTerm gateway -> HUD). Zero-dependency
single file (`server.mjs`, hand-written MCP stdio protocol — no SDK); remote
deployment only needs node >= 18. stdout is reserved for RPC; debug output goes
to stderr.

## Session attribution

The MCP protocol carries no session id; on the first `tools/call` the server
resolves one, in order of trust, and sticks to it for the process lifetime
(one MCP server per session):

1. The `sid` argument echoed by the model — the codex hook injects the
   session's sid at `SessionStart` and in every reminder. Accepted only if a
   matching timer-state file exists under `~/.codex/ath_report/`, so a
   hallucinated sid falls through to the heuristics instead of creating a
   ghost card.
2. Timer state whose `cwd` matches this process's cwd, newest first
   (separates concurrent sessions).
3. Globally newest timer-state file.
4. Standalone `codex:mcp-<pid>` card.

Residual limitation: two concurrent codex sessions in the same directory, with
no sid echoed, still race on mtime.

## Register in codex

`~/.codex/config.toml` (installer step 2 writes this block; restart codex to
take effect — no `/hooks` trust needed for MCP):

```toml
[mcp_servers.ath]
command = "node"
args = ["/path/to/agent-hook/remote/ath-report-mcp/server.mjs"]
```

## Transport

Same semantics as `agents/codex/hook.mjs`: tty by default (needs a real TTY —
WSL/SSH), `ATH_TRANSPORT=http` forces direct gateway HTTP; `ATH_URL`, `ATH_SEND`,
`ATH_TOKEN` override endpoint/paths/auth. A failed forward still answers the
model with "noted, please continue" — it must never retry or get distracted.

## Verify without codex

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ath_report","arguments":{"action":"self test"}}}' \
| node server.mjs
```

Three JSON-RPC responses plus `[ath] report forwarded: TTY ok` on stderr means
the link works.
