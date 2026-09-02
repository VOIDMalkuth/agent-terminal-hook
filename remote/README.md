# remote/ — collection layer for machines where agents run

| Component | Status | Notes |
|---|---|---|
| `ath-send` | done | single exit point: JSON -> base64 -> OSC 1337 SetUserVar -> `/dev/tty`; automatic tmux DCS passthrough |
| `ath-report-mcp/` | done (Codex) | stdio MCP server exposing `ath_report(action, reason?, next?)`; forwards via ath-send |

## Deploy ath-send

```sh
scp remote/ath-send server:/usr/local/bin/
ssh server 'chmod +x /usr/local/bin/ath-send'
```

Smoke test (WezTerm with a direct SSH connection):

```sh
echo '{"v":1,"type":"register","sid":"cli:test@host","title":"link test"}' | ath-send
```

## tmux: allow passthrough

ath-send wraps the sequence in `DCS tmux;...ST` when `$TMUX` is set; **tmux >= 3.3
defaults `allow-passthrough off` and swallows it** (symptom: works without tmux,
nothing happens inside tmux):

```sh
tmux set -g allow-passthrough on    # takes effect immediately
# persist: add  set -g allow-passthrough on  to ~/.tmux.conf
```

tmux < 3.3 has no such option and always passes through; ath-send warns on stderr
when it detects `off`.

## Design notes

- **No transcript tailer**: the op stream comes from CLI hooks, reports from
  `ath_report` — both only call `ath-send`.
- **`state=waiting_input` sources**: permission requests and turn end (Stop).
- **`sid` = `<agent>:<session uuid>`** straight from hook stdin: survives tmux
  detach/attach and SSH reconnects as the same card. The HUD holds sids in
  memory only.
- Tolerance: sessions may skip `register` (first message creates the card) and
  skip `bye` (card goes stale, deletable); a later message with the same sid
  revives it.
- Hooks must return in milliseconds: ath-send only writes to the TTY, no network.
- The channel carries no auth; safety is enforced on the receiving side
  (loopback bind + token + display-only), see design.md.
