import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { ELAPSED_SINCE_DESCRIPTION, ERROR_MESSAGES, NOW_DESCRIPTION } from "../src/server";
import { makeToken, verifyToken } from "../src/token";

const BASE = { ...(env as unknown as Env), DEFAULT_TIMEZONE: "" } as Env;
const AUTH = BASE.AUTH_SECRET;
const TOKEN_SECRET = BASE.TOKEN_SECRET;
const ORIGIN = "https://unixtime.test";

const nowUnix = () => Math.floor(Date.now() / 1000);

const stubLimiter = (success: boolean, seen: string[] = []): RateLimit => ({
  async limit({ key }) {
    seen.push(key);
    return { success };
  },
});

type SendOptions = RequestInit & { env?: Partial<Env> };

async function send(path: string, { env: overrides, ...init }: SendOptions = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init) as Parameters<typeof worker.fetch>[0];
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...BASE, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const rpc = (method: string, params?: unknown, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

const jsonHeaders = (auth?: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(auth === undefined ? {} : { authorization: auth }),
});

async function post(path: string, body: string, headers: Record<string, string>, overrides?: Partial<Env>) {
  return send(path, { method: "POST", body, headers, env: overrides });
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  opts: { path?: string; env?: Partial<Env> } = {},
): Promise<CallToolResult> {
  const res = await post(opts.path ?? "/mcp", rpc("tools/call", { name, arguments: args }), jsonHeaders(`Bearer ${AUTH}`), opts.env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: CallToolResult; error?: unknown };
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as CallToolResult;
}

const textOf = (r: CallToolResult) => (r.content[0] as { type: "text"; text: string }).text;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("now", () => {
  it("returns integer unix, matching iso_utc, and a token that verifies", async () => {
    const before = nowUnix();
    const result = await callTool("now");
    const after = nowUnix();

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { unix: number; iso_utc: string; token: string };
    expect(Number.isInteger(out.unix)).toBe(true);
    expect(out.unix).toBeGreaterThanOrEqual(before);
    expect(out.unix).toBeLessThanOrEqual(after);
    expect(out.iso_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(out.iso_utc) / 1000).toBe(out.unix);
    expect(out.token).toMatch(/^\d{1,12}\.[0-9a-f]{8}$/);
    expect(out.token.startsWith(`${out.unix}.`)).toBe(true);
    expect(await verifyToken(out.token, TOKEN_SECRET, after)).toEqual({ ok: true, unix: out.unix });

    // The text block carries the same JSON as structuredContent.
    expect(JSON.parse(textOf(result))).toEqual(out);
  });
});

describe("elapsed_since", () => {
  it("with a fresh token returns elapsed_seconds of 0 or 1 and a verifying token", async () => {
    const { token } = (await callTool("now")).structuredContent as { token: string };
    const result = await callTool("elapsed_since", { token });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, number | string>;
    expect([0, 1]).toContain(out.elapsed_seconds);
    expect(out.end_unix).toBe((out.start_unix as number) + (out.elapsed_seconds as number));
    expect(out.elapsed_hours_decimal).toBe(0);
    expect(out.start_iso_utc).toBe(new Date((out.start_unix as number) * 1000).toISOString().replace(".000Z", "Z"));
    expect((await verifyToken(out.token as string, TOKEN_SECRET, nowUnix())).ok).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(out);
  });

  it("with a token from 5,527 seconds ago returns 1h 32m 07s and 1.54", async () => {
    const fixedNow = 1791386727; // 2026-10-07T15:25:27Z
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow * 1000);

    const token = await makeToken(fixedNow - 5527, TOKEN_SECRET);
    const result = await callTool("elapsed_since", { token });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      start_unix: fixedNow - 5527,
      start_iso_utc: "2026-10-07T13:53:20Z",
      end_unix: fixedNow,
      end_iso_utc: "2026-10-07T15:25:27Z",
      elapsed_seconds: 5527,
      elapsed_human: "1h 32m 07s",
      elapsed_hours_decimal: 1.54,
      token: await makeToken(fixedNow, TOKEN_SECRET),
    });
  });

  it("formats 24 hours or more as Nd HHh MMm SSs", async () => {
    const fixedNow = 1791386727;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow * 1000);

    const token = await makeToken(fixedNow - (86400 * 2 + 3 * 3600 + 4 * 60 + 5), TOKEN_SECRET);
    const out = (await callTool("elapsed_since", { token })).structuredContent as Record<string, unknown>;
    expect(out.elapsed_human).toBe("2d 03h 04m 05s");
    expect(out.elapsed_hours_decimal).toBe(51.07);
  });

  it("chains: the returned token is a normal now() token", async () => {
    const first = (await callTool("now")).structuredContent as { token: string };
    const mid = (await callTool("elapsed_since", { token: first.token })).structuredContent as { token: string };
    const last = await callTool("elapsed_since", { token: mid.token });
    expect(last.isError).toBeFalsy();
  });

  it("fails verification when any single digit of a valid token is changed", async () => {
    const token = await makeToken(nowUnix() - 100, TOKEN_SECRET);
    const [unixPart, sigPart] = token.split(".");
    const hex = "0123456789abcdef";

    const variants: string[] = [];
    for (let i = 0; i < unixPart.length; i++) {
      const d = (Number(unixPart[i]) + 1) % 10;
      if (i === 0 && d === 0) continue; // keep the same digit count; a leading zero is still well-formed anyway
      variants.push(unixPart.slice(0, i) + d + unixPart.slice(i + 1) + "." + sigPart);
    }
    for (let i = 0; i < sigPart.length; i++) {
      const c = hex[(hex.indexOf(sigPart[i]) + 1) % 16];
      variants.push(unixPart + "." + sigPart.slice(0, i) + c + sigPart.slice(i + 1));
    }
    expect(variants.length).toBeGreaterThanOrEqual(unixPart.length - 1 + sigPart.length);

    for (const v of variants) {
      const result = await callTool("elapsed_since", { token: v });
      expect(result.isError, v).toBe(true);
      expect(textOf(result), v).toBe(ERROR_MESSAGES.bad_signature);
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it("fails verification for a well-formed token with an invented signature", async () => {
    for (const sig of ["deadbeef", "00000000", "a3f91c07"]) {
      const result = await callTool("elapsed_since", { token: `${nowUnix() - 60}.${sig}` });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(ERROR_MESSAGES.bad_signature);
    }
  });

  it("returns the specified tool error for a malformed token", async () => {
    for (const bad of ["", "not-a-token", "1791381600", "1791381600.ABCDEF01", "1791381600.abc", "1791381600.abcdef012"]) {
      const result = await callTool("elapsed_since", { token: bad });
      expect(result.isError, bad).toBe(true);
      expect(textOf(result), bad).toBe(ERROR_MESSAGES.malformed);
    }
  });

  it("returns the specified tool error for a future-dated token", async () => {
    const result = await callTool("elapsed_since", { token: await makeToken(nowUnix() + 3600, TOKEN_SECRET) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(ERROR_MESSAGES.future);
  });

  it("tolerates up to 60 seconds of clock skew", async () => {
    const result = await callTool("elapsed_since", { token: await makeToken(nowUnix() + 30, TOKEN_SECRET) });
    expect(result.isError).toBeFalsy();
  });

  it("reports a missing token as a tool error, never as an HTTP error", async () => {
    const res = await post("/mcp", rpc("tools/call", { name: "elapsed_since", arguments: {} }), jsonHeaders(`Bearer ${AUTH}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: unknown; result?: CallToolResult };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(textOf(body.result!)).toMatch(/Input validation error/);
  });
});

describe("timezone", () => {
  const fixedNow = 1782907200; // 2026-07-01T12:00:00Z, British Summer Time

  it("adds local fields to now() when ?tz= is given on either route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow * 1000);
    for (const path of ["/mcp?tz=Europe/London", `/mcp/${AUTH}?tz=Europe%2FLondon`]) {
      const out = (await callTool("now", {}, { path })).structuredContent as Record<string, unknown>;
      expect(out.unix).toBe(fixedNow);
      expect(out.iso_utc).toBe("2026-07-01T12:00:00Z");
      expect(out.timezone).toBe("Europe/London");
      expect(out.local_iso).toBe("2026-07-01T13:00:00+01:00");
      expect(out.local_human).toBe("Wed 1 Jul 2026, 13:00:00 BST");
    }
  });

  it("adds start and end local fields to elapsed_since", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow * 1000);
    const token = await makeToken(fixedNow - 5527, TOKEN_SECRET);
    const out = (await callTool("elapsed_since", { token }, { path: "/mcp?tz=America/New_York" })).structuredContent as Record<string, unknown>;
    expect(out.timezone).toBe("America/New_York");
    expect(out.start_local_iso).toBe("2026-07-01T06:27:53-04:00");
    expect(out.start_local_human).toBe("Wed 1 Jul 2026, 06:27:53 EDT");
    expect(out.end_local_iso).toBe("2026-07-01T08:00:00-04:00");
    expect(out.elapsed_human).toBe("1h 32m 07s");
    // The token is zone-independent: the same token verifies with no zone at all.
    expect((await callTool("elapsed_since", { token })).isError).toBeFalsy();
  });

  it("falls back to DEFAULT_TIMEZONE, which ?tz= overrides", async () => {
    const dflt = (await callTool("now", {}, { env: { DEFAULT_TIMEZONE: "Asia/Tokyo" } })).structuredContent as Record<string, unknown>;
    expect(dflt.timezone).toBe("Asia/Tokyo");
    expect(dflt.local_iso).toMatch(/\+09:00$/);
    const over = (await callTool("now", {}, { path: "/mcp?tz=UTC", env: { DEFAULT_TIMEZONE: "Asia/Tokyo" } })).structuredContent as Record<string, unknown>;
    expect(over.timezone).toBe("UTC");
    expect(over.local_iso).toMatch(/\+00:00$/);
  });

  it("omits the local fields entirely when no zone is configured", async () => {
    const out = (await callTool("now")).structuredContent as Record<string, unknown>;
    expect(out).not.toHaveProperty("timezone");
    expect(out).not.toHaveProperty("local_iso");
    expect(out).not.toHaveProperty("local_human");
    expect(JSON.parse(textOf(await callTool("now")))).not.toHaveProperty("local_iso");
  });

  it("returns a bare 400 for an unknown zone, from the URL or the default", async () => {
    const res = await post("/mcp?tz=Nowhere/Land", rpc("ping"), jsonHeaders(`Bearer ${AUTH}`));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
    expect((await post("/mcp", rpc("ping"), jsonHeaders(`Bearer ${AUTH}`), { DEFAULT_TIMEZONE: "Nowhere/Land" })).status).toBe(400);
    // Auth is still checked first: a bad zone with bad credentials is a 401, not a 400.
    expect((await post("/mcp?tz=Nowhere/Land", rpc("ping"), jsonHeaders("Bearer nope"))).status).toBe(401);
  });

  it("mentions the zone in the tool descriptions and instructions", async () => {
    const res = await post("/mcp?tz=Europe/London", rpc("tools/list"), jsonHeaders(`Bearer ${AUTH}`));
    const { result } = (await res.json()) as { result: { tools: Array<{ name: string; description: string }> } };
    for (const t of result.tools) {
      expect(t.description.startsWith(t.name === "now" ? NOW_DESCRIPTION : ELAPSED_SINCE_DESCRIPTION)).toBe(true);
      expect(t.description).toContain("Europe/London");
    }
    const init = await post("/mcp?tz=Europe/London", rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }), jsonHeaders(`Bearer ${AUTH}`));
    expect(((await init.json()) as { result: { instructions: string } }).result.instructions).toContain("Europe/London");
  });
});

describe("tools/list", () => {
  it("advertises exactly the two tools with the specified descriptions and schemas", async () => {
    const res = await post("/mcp", rpc("tools/list"), jsonHeaders(`Bearer ${AUTH}`));
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: any; outputSchema?: any }> };
    };
    expect(result.tools.map((t) => t.name).sort()).toEqual(["elapsed_since", "now"]);

    const now = result.tools.find((t) => t.name === "now")!;
    expect(now.description).toBe(NOW_DESCRIPTION);
    expect(now.outputSchema.required).toEqual(expect.arrayContaining(["unix", "iso_utc", "token"]));

    const elapsed = result.tools.find((t) => t.name === "elapsed_since")!;
    expect(elapsed.description).toBe(ELAPSED_SINCE_DESCRIPTION);
    expect(elapsed.inputSchema.required).toEqual(["token"]);
    expect(elapsed.inputSchema.properties.token.type).toBe("string");
    expect(elapsed.outputSchema.required).toEqual(
      expect.arrayContaining(["start_unix", "start_iso_utc", "end_unix", "end_iso_utc", "elapsed_seconds", "elapsed_human", "elapsed_hours_decimal", "token"]),
    );
  });
});

describe("authentication", () => {
  const ping = rpc("ping");

  it("accepts a correct Bearer header", async () => {
    expect((await post("/mcp", ping, jsonHeaders(`Bearer ${AUTH}`))).status).toBe(200);
    expect((await post("/mcp", ping, jsonHeaders(`bearer ${AUTH}`))).status).toBe(200);
  });

  it("returns a bare 401 for a wrong or missing header", async () => {
    for (const auth of [undefined, "", "Bearer", `Bearer ${AUTH}x`, `Bearer ${AUTH.slice(0, -1)}`, `Basic ${AUTH}`, AUTH, `Bearer ${AUTH} extra`]) {
      const res = await post("/mcp", ping, jsonHeaders(auth));
      expect(res.status, String(auth)).toBe(401);
      expect(await res.text()).toBe("");
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("accepts the path secret when ALLOW_PATH_SECRET is true", async () => {
    expect((await post(`/mcp/${AUTH}`, ping, jsonHeaders())).status).toBe(200);
    expect((await post(`/mcp/${AUTH}`, ping, jsonHeaders(), { ALLOW_PATH_SECRET: "true" })).status).toBe(200);
    expect((await post(`/mcp/${AUTH}`, ping, jsonHeaders(), { ALLOW_PATH_SECRET: undefined })).status).toBe(200);
  });

  it("returns 401 for a wrong path secret", async () => {
    expect((await post(`/mcp/${AUTH}x`, ping, jsonHeaders())).status).toBe(401);
    expect((await post(`/mcp/${AUTH.slice(0, -1)}`, ping, jsonHeaders())).status).toBe(401);
    expect((await post("/mcp/wrong", ping, jsonHeaders())).status).toBe(401);
  });

  it("checks the header first, so a valid header works even with a wrong path secret", async () => {
    expect((await post("/mcp/wrong", ping, jsonHeaders(`Bearer ${AUTH}`))).status).toBe(200);
  });

  it("returns 404 on the path route when ALLOW_PATH_SECRET is false, while header auth still works", async () => {
    for (const off of ["false", "FALSE", " false ", false] as const) {
      const res = await post(`/mcp/${AUTH}`, ping, jsonHeaders(), { ALLOW_PATH_SECRET: off });
      expect(res.status, String(off)).toBe(404);
      expect(await res.text()).toBe("");
      // Even a valid header does not resurrect the path route.
      expect((await post(`/mcp/${AUTH}`, ping, jsonHeaders(`Bearer ${AUTH}`), { ALLOW_PATH_SECRET: off })).status).toBe(404);
      expect((await post("/mcp", ping, jsonHeaders(`Bearer ${AUTH}`), { ALLOW_PATH_SECRET: off })).status).toBe(200);
    }
  });

  it("returns a bare 404 for any other path, authenticated or not", async () => {
    for (const path of ["/", "/mcp/", "/mcp/a/b", "/MCP", "/mcpx", "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/sse", "/favicon.ico"]) {
      const res = await send(path, { headers: { authorization: `Bearer ${AUTH}` } });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("never logs on the path route or on auth failure", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    await post(`/mcp/${AUTH}`, ping, jsonHeaders());
    await post(`/mcp/${AUTH}x`, ping, jsonHeaders());
    await post("/mcp", ping, jsonHeaders(`Bearer wrong`));
    await send("/nope");
    for (const spy of [log, error, warn]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("rate limiting", () => {
  it("returns 429 when the limiter says no, before auth is evaluated", async () => {
    const seen: string[] = [];
    const res = await post("/mcp", rpc("ping"), { ...jsonHeaders(`Bearer ${AUTH}`), "cf-connecting-ip": "203.0.113.9" },
      { RATE_LIMITER: stubLimiter(false, seen) });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("");
    expect(seen).toEqual(["203.0.113.9"]);

    // Unauthenticated and unknown paths are throttled too.
    expect((await send("/anything", { env: { RATE_LIMITER: stubLimiter(false) } })).status).toBe(429);
  });

  it("passes through when the limiter allows", async () => {
    const res = await post("/mcp", rpc("ping"), jsonHeaders(`Bearer ${AUTH}`), { RATE_LIMITER: stubLimiter(true) });
    expect(res.status).toBe(200);
  });

  it("is backed by a real Workers rate limit binding in this runtime", async () => {
    expect(typeof BASE.RATE_LIMITER.limit).toBe("function");
    expect(await BASE.RATE_LIMITER.limit({ key: "binding-smoke" })).toEqual({ success: true });
  });
});

describe("MCP SDK client end to end", () => {
  async function connect(url: string, headers?: Record<string, string>) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        send(new URL(input instanceof Request ? input.url : String(input)).pathname, { ...init, headers: init?.headers })) as typeof fetch,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  it("initializes, lists tools and calls both over the Bearer route", async () => {
    const client = await connect(`${ORIGIN}/mcp`, { authorization: `Bearer ${AUTH}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["elapsed_since", "now"]);

    const now = (await client.callTool({ name: "now" })) as CallToolResult;
    const { token } = now.structuredContent as { token: string };
    const elapsed = (await client.callTool({ name: "elapsed_since", arguments: { token } })) as CallToolResult;
    expect(elapsed.isError).toBeFalsy();
    expect([0, 1]).toContain((elapsed.structuredContent as { elapsed_seconds: number }).elapsed_seconds);
    await client.close();
  });

  it("works over the path-secret route with no auth header", async () => {
    const client = await connect(`${ORIGIN}/mcp/${AUTH}`);
    const now = (await client.callTool({ name: "now" })) as CallToolResult;
    expect(now.isError).toBeFalsy();
    await client.close();
  });

  it("refuses to connect with a bad secret", async () => {
    await expect(connect(`${ORIGIN}/mcp`, { authorization: "Bearer nope" })).rejects.toThrow(/Error POSTing to endpoint/);
  });
});
