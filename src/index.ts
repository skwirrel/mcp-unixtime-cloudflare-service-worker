import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "./compare";
import { pathSecretAllowed, type Env } from "./env";
import { createServer } from "./server";

export type { Env } from "./env";

// `/mcp` or `/mcp/<one path segment>`; nothing else is routed.
const MCP_PATH_RE = /^\/mcp(?:\/([^/]+))?$/;

const bare = (status: number, headers?: HeadersInit) => new Response(null, { status, headers });

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return timingSafeEqual(m[1], secret);
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless: a fresh server and transport per request, no session id.
  const server = createServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Nothing persists between requests; release the pair promptly.
    void transport.close().catch(() => {});
  }
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    // Rate limit before anything else so that credential guessing is throttled too.
    const { success } = await env.RATE_LIMITER.limit({ key: clientIp(request) });
    if (!success) {
      return bare(429, { "retry-after": "60" });
    }

    const { pathname } = new URL(request.url);
    const match = MCP_PATH_RE.exec(pathname);
    if (!match) {
      return bare(404);
    }

    const pathSecret = match[1];
    if (pathSecret !== undefined && !pathSecretAllowed(env)) {
      return bare(404);
    }

    // Header first, then path. Both are constant-time comparisons.
    const headerOk = bearerMatches(request.headers.get("authorization"), env.AUTH_SECRET);
    const pathOk = pathSecret !== undefined && timingSafeEqual(pathSecret, env.AUTH_SECRET);
    if (!headerOk && !pathOk) {
      return bare(401);
    }

    try {
      return await handleMcp(request, env);
    } catch (err) {
      // Never log the request: on the path route its URL is a credential.
      console.error("mcp handler failed:", err instanceof Error ? err.message : String(err));
      return bare(500);
    }
  },
} satisfies ExportedHandler<Env>;
