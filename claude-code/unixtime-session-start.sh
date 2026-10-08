#!/usr/bin/env bash
# Claude Code SessionStart hook: stamp the start of a session using the unixtime MCP server.
# Whatever this prints to stdout is added to Claude's context at the start of the session.
# Needs ~/.config/unixtime/env (chmod 600) containing:
#   UNIXTIME_URL=https://your-worker.example.com
#   UNIXTIME_AUTH_SECRET=<AUTH_SECRET>
# Fails silently (prints nothing, exit 0) if the file is missing or the server is unreachable,
# so a network blip never blocks a session from starting.
set -u
CONF="${UNIXTIME_CONF:-$HOME/.config/unixtime/env}"
[ -r "$CONF" ] || exit 0
# shellcheck source=/dev/null
. "$CONF"
[ -n "${UNIXTIME_URL:-}" ] && [ -n "${UNIXTIME_AUTH_SECRET:-}" ] || exit 0

RESP=$(curl -sS --max-time 5 \
  -H "authorization: Bearer $UNIXTIME_AUTH_SECRET" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -X POST --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"now","arguments":{}}}' \
  "${UNIXTIME_URL%/}/mcp" 2>/dev/null) || exit 0

if command -v jq >/dev/null 2>&1; then
  read -r UNIX ISO TOKEN < <(printf '%s' "$RESP" | jq -r '.result.structuredContent | "\(.unix) \(.iso_utc) \(.token)"' 2>/dev/null)
else
  read -r UNIX ISO TOKEN < <(printf '%s' "$RESP" | sed -n 's/.*"structuredContent":{"unix":\([0-9]*\),"iso_utc":"\([^"]*\)","token":"\([^"]*\)".*/\1 \2 \3/p')
fi
[ -n "${TOKEN:-}" ] && [ "$TOKEN" != "null" ] || exit 0

cat <<MSG
Session timer (unixtime MCP server): this session started at $ISO (unix $UNIX).
Start token: $TOKEN
If asked when this session started or how long it has been running, call the unixtime elapsed_since tool with that token exactly as written and report its elapsed_human value. Do not estimate.
MSG
