#!/bin/sh
# osc-demo -- WezTerm pipeline demo: OSC 1337 SetUserVar -> ath-gateway.lua -> HUD.
# Prereqs: the HUD is running; the current WezTerm config loads gateway/wezterm/ath-gateway.lua.
# Effect: an "OSC demo" card appears, works for a few seconds, returns to waiting_input.
set -eu
SEND="$(cd "$(dirname "$0")" && pwd)/../remote/ath-send"
# Fixed sid: reruns update the same card (the HUD aggregates by sid); change it for more cards
SID="demo:osc"

send() {
  printf '%s' "$1" | sh "$SEND"
}

echo "[demo] register（waiting_input）"
send "{\"v\":1,\"type\":\"register\",\"sid\":\"$SID\",\"agent\":\"demo\",\"title\":\"OSC demo\",\"state\":\"waiting_input\"}"
sleep 0.5

echo "[demo] working + op start"
send "{\"v\":1,\"type\":\"state\",\"sid\":\"$SID\",\"state\":\"working\"}"
send "{\"v\":1,\"type\":\"op\",\"sid\":\"$SID\",\"op\":{\"tool\":\"Bash\",\"summary\":\"demo op start\",\"phase\":\"start\",\"key\":\"k1\"}}"
sleep 3

echo "[demo] op end + 回到 waiting_input"
send "{\"v\":1,\"type\":\"op\",\"sid\":\"$SID\",\"op\":{\"tool\":\"Bash\",\"phase\":\"end\",\"key\":\"k1\"}}"
send "{\"v\":1,\"type\":\"state\",\"sid\":\"$SID\",\"state\":\"waiting_input\"}"

echo "[demo] 完成——HUD 的「OSC demo」卡片应已更新为等输入态；重跑刷新同一张卡"
