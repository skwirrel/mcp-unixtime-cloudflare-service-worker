# Unixtime MCP Server

A tiny, stateless [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers with two tools:

| Tool | What it does |
| --- | --- |
| `now` | Returns the current Unix time (UTC) and a signed token. Call it when a conversation starts. |
| `elapsed_since` | Takes a token from `now`, verifies it, and returns start, end, elapsed time (pre-formatted) and a fresh token. |

Everything is Unix time in UTC. There is no storage: the start time lives in the conversation as a token
that is HMAC-signed, so the model cannot invent or mangle one without the server noticing.

## Why

Claude has no idea what time it is, and no way to tell how long a conversation has been running. I
wanted both: to know when a particular conversation started, and how long we had been discussing
something, so that time spent with Claude on client work could go onto a timesheet.

With this connector and a one-line instruction in Claude's preferences, every conversation opens with a
timestamp, and at any point I can ask how long it has been going and get a figure that is measured
rather than guessed. The signed token is what makes the answer trustworthy: Claude cannot make up a
plausible-looking start time, it can only hand back one the server issued.

It replaces the third-party "Time MCP Server" listings, which point at an npm package the official MCP
project does not publish. It deliberately does little else: no storage, no accounts, and the only
timezone handling is an optional "also show me the local time in my zone" setting.

```json
// now
{ "unix": 1791391200, "iso_utc": "2026-10-07T14:00:00Z", "token": "1791391200.a3f91c07" }

// elapsed_since { "token": "1791391200.a3f91c07" }
{
  "start_unix": 1791391200, "start_iso_utc": "2026-10-07T14:00:00Z",
  "end_unix": 1791396727,   "end_iso_utc": "2026-10-07T15:32:07Z",
  "elapsed_seconds": 5527, "elapsed_human": "1h 32m 07s", "elapsed_hours_decimal": 1.54,
  "token": "1791396727.5be20d1e"
}
```

Tool failures (malformed token, bad signature, token dated in the future) come back as MCP tool errors
with a plain-English message, never as HTTP errors.

**Local time, optionally.** Most people live in one timezone and would like Claude to quote the time
in it. Add `?tz=<IANA zone>` to the connector URL, or set `DEFAULT_TIMEZONE` on the Worker, and both
tools also return the local time:

```json
// now, with ?tz=Europe/London
{ "unix": 1791391200, "iso_utc": "2026-10-07T14:00:00Z", "token": "1791391200.a3f91c07",
  "timezone": "Europe/London", "local_iso": "2026-10-07T15:00:00+01:00",
  "local_human": "Wed 7 Oct 2026, 15:00:00 BST" }
```

`elapsed_since` gains `start_local_iso`, `start_local_human`, `end_local_iso` and `end_local_human` in
the same way, and the tool descriptions tell the model to quote local time unless asked for UTC. DST
is handled by the runtime's ICU data. Tokens are unaffected, so the same token works whatever zone
each request names. An unknown zone name gets a bare `400`, so a typo shows up when the connector is
added rather than as a wrong time later.

## Layout

```
src/index.ts    fetch handler: rate limit, routing, auth, hands /mcp to the SDK transport
src/server.ts   McpServer with the two tools
src/token.ts    HMAC-SHA256 token sign / verify (Web Crypto, key cached per isolate)
src/format.ts   elapsed_human, elapsed_hours_decimal, ISO formatting
src/compare.ts  constant-time string comparison
test/           Vitest suite that runs inside workerd via @cloudflare/vitest-pool-workers
wrangler.jsonc  Worker config: vars, rate limit binding, custom domain placeholder
```

The server uses `@modelcontextprotocol/sdk` with its Web-standard Streamable HTTP transport in stateless
mode: a fresh `McpServer` and transport per request, no session id, JSON responses. No Durable Objects,
KV or `McpAgent`.

## Setup

Requires Node 20+ (an `.nvmrc` pins 24) and a Cloudflare account.

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in two values from `openssl rand -hex 32`
npx wrangler login
```

## Secrets and variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `AUTH_SECRET` | Secret | Shared secret for header and path auth. At least 32 random hex chars. |
| `TOKEN_SECRET` | Secret | HMAC key for timestamp tokens. Different from `AUTH_SECRET`. |
| `ALLOW_PATH_SECRET` | Variable | `"true"` (default) enables `/mcp/<AUTH_SECRET>`; `"false"` retires it. |
| `RATE_LIMITER` | Binding | Workers rate limit, 60 requests per minute per client IP, `429` when exceeded. |
| `DEFAULT_TIMEZONE` | Variable | Optional IANA zone (e.g. `Europe/London`) for local-time fields. `?tz=` on the URL overrides it. Empty means UTC only. |

```sh
openssl rand -hex 32 | npx wrangler secret put AUTH_SECRET
openssl rand -hex 32 | npx wrangler secret put TOKEN_SECRET
```

Locally, `wrangler dev` and the tests read `.dev.vars`. Never commit it; `.gitignore` already excludes it.

## Deploy

1. Decide the hostname. In `wrangler.jsonc`, uncomment `routes` and set the `pattern` to your domain
   (it must be a zone on the same Cloudflare account), and set `workers_dev` to `false` if you do not want
   the `*.workers.dev` URL as well.
2. `npm run deploy`

The Worker must stay publicly reachable: Claude web calls connectors from Anthropic's infrastructure,
so do not put it behind Cloudflare Access.

## Connecting clients

Replace `unixtime.example.com` with your hostname. Until a custom domain is set, the Worker is live at
`https://mcp-unixtime.conflab.workers.dev`. To get local time as well as UTC, append `?tz=<IANA zone>`
to any of the URLs below, e.g. `https://unixtime.example.com/mcp?tz=Europe/London`, or set
`DEFAULT_TIMEZONE` on the Worker and leave the URLs as they are.

**Claude Code**

```sh
claude mcp add --transport http unixtime https://unixtime.example.com/mcp \
  --header "Authorization: Bearer <AUTH_SECRET>"
```

**Claude web / desktop / mobile, with the custom request headers beta**

Settings → Connectors → Add custom connector. URL `https://unixtime.example.com/mcp`, and a request
header named `Authorization` with the value `Bearer <AUTH_SECRET>` (include the word `Bearer`).
Authentication settings cannot be edited later; remove and re-add the connector to rotate.

**Claude web without the header beta**

Add a custom connector at `https://unixtime.example.com/mcp/<AUTH_SECRET>` with no authentication.
The whole URL is a credential: treat it like a password.

**Getting Claude to use it**

Nothing triggers a tool call on its own, and the right way to prompt it differs by client:

- *Claude web, desktop and mobile:* add an instruction to your user preferences (Settings →
  Profile). This is the one I use, and it works well:

  > Use the unixtime mcp connector to get the current time at the start of each conversation because
  > sometimes I will later want to know when a particular conversation started and how long we've been
  > discussing it.

  Then, whenever you want the figure, just ask how long the conversation has been going.

- *Claude Code:* you probably do not need this server at all. Every session is logged locally under
  `~/.claude/projects/<project>/`, and each message in those transcript files carries a timestamp, so
  the start time and duration of a session can be read straight from the log. If you have added the
  connector in Claude web it shows up in Claude Code anyway through connector sync (`claude mcp list`
  will list it), so the tools are there if you ever want them.

Claude has no hook for a conversation ending, so the end is either an explicit request or the last
checkpoint taken. The token returned by `elapsed_since` is an ordinary `now` token, so you can chain
checkpoints through a long conversation.

## Authentication details

- `Authorization: Bearer <AUTH_SECRET>` is checked first, then the `/mcp/<AUTH_SECRET>` path.
  Both comparisons are constant-time.
- Wrong or missing credentials get a bare `401`. Any path other than `/mcp` or `/mcp/<secret>` gets a
  bare `404`, including the OAuth well-known endpoints: the server advertises no OAuth metadata.
- With `ALLOW_PATH_SECRET` set to `"false"`, `/mcp/<anything>` returns `404` even with a valid header.
  Set it in `wrangler.jsonc` (or the dashboard) and redeploy.
- Rate limiting runs before auth, so credential guessing is throttled as well.

## Testing

```sh
npm run typecheck
npm test            # Vitest inside the Workers runtime (workerd) via @cloudflare/vitest-pool-workers
npm run test:docker # same suite in a node:24-bookworm container, for hosts whose glibc is too old for workerd
```

The suite covers the acceptance list from the build spec: token signing and verification, the
`1h 32m 07s` / `1.54` example, day-length formatting, every single-digit mutation of a valid token,
invented signatures, malformed and future-dated tokens, header and path auth, `ALLOW_PATH_SECRET`,
the `429` path, that nothing is logged on the path route, and a full handshake with the SDK's own
Streamable HTTP client over both routes.

Manual check with MCP Inspector:

```sh
npm run dev                                    # http://localhost:8787
npx @modelcontextprotocol/inspector            # transport: Streamable HTTP
```

Point it at `http://localhost:8787/mcp` with an `Authorization: Bearer <AUTH_SECRET>` header, or at
`http://localhost:8787/mcp/<AUTH_SECRET>` with none. Repeat against the deployed URL after deploying.

## Logging

The Worker never logs the request URL, the `Authorization` header or either secret. The only log line
it can emit is an error message if the MCP handler throws.

Two things to know about Cloudflare's own logging:

- `wrangler tail` prints the request URL of every event it shows. On the path route that URL contains
  `AUTH_SECRET`. Prefer header auth when tailing, or filter: `wrangler tail --format json | jq 'del(.event.request.url)'`.
- Workers Observability (persisted invocation logs) is left disabled in `wrangler.jsonc` for the same reason.
- `wrangler dev` prints one `[wrangler:info] POST /mcp/... 200 OK` line per request to your terminal,
  which includes the path secret when you use that route locally. Use the header route when developing.

## Rotating secrets

The two secrets are independent, so rotating one does not affect the other.

**`AUTH_SECRET`** (who may call the server)

1. `openssl rand -hex 32 | npx wrangler secret put AUTH_SECRET` (takes effect immediately, no redeploy).
2. Update every client: re-run `claude mcp add` with the new header, and remove and re-add any Claude
   web connector with the new header or new path URL.

**`TOKEN_SECRET`** (what signs timestamp tokens)

1. `openssl rand -hex 32 | npx wrangler secret put TOKEN_SECRET`.
2. Any token issued before the rotation now fails verification with "Token failed verification".
   Start a new timer in affected conversations. This is expected and acceptable.

**Retiring the path route** once header auth is available everywhere: set `ALLOW_PATH_SECRET` to
`"false"` in `wrangler.jsonc`, redeploy, and rotate `AUTH_SECRET` since the old value was in URLs.

## Out of scope

Timezone conversion beyond the single optional display zone, persistent storage or server-side timing
logs, OAuth or multi-user support, calendar integration, sub-second precision.

## License

[MIT](LICENSE).
