import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "./env";
import { formatElapsed, hoursDecimal, isoUtc } from "./format";
import { makeToken, TOKEN_PATTERN, verifyToken, type VerifyFailure } from "./token";

export const SERVER_NAME = "unixtime";
export const SERVER_VERSION = "1.0.0";

export const NOW_DESCRIPTION =
  "Returns the current Unix time (UTC) and a signed token. Call at the start of a conversation to start the timer. " +
  "Keep the token exactly as returned; you will pass it to elapsed_since later. Never invent or alter a token.";

export const ELAPSED_SINCE_DESCRIPTION =
  "Given a token from now(), returns how long has elapsed since it was issued, plus a fresh token for the current time. " +
  "Pass the token verbatim. If verification fails, do not guess a time: tell the user.";

export const ERROR_MESSAGES: Record<VerifyFailure, string> = {
  malformed: "Token is not in the expected format.",
  bad_signature:
    "Token failed verification. It may have been mistyped. Do not estimate; ask the user or start a new timer.",
  future: "Token time is in the future.",
};

const nowOutput = {
  unix: z.number().int().describe("Current Unix time in whole seconds (UTC)."),
  iso_utc: z.string().describe("The same instant as ISO 8601 UTC, e.g. 2026-10-07T14:00:00Z."),
  token: z.string().describe("Signed token for this instant. Pass it verbatim to elapsed_since."),
};

const elapsedInput = {
  token: z
    .string()
    .describe(`Token exactly as returned by now() or elapsed_since(). Format: ${TOKEN_PATTERN}`),
};

const elapsedOutput = {
  start_unix: z.number().int(),
  start_iso_utc: z.string(),
  end_unix: z.number().int(),
  end_iso_utc: z.string(),
  elapsed_seconds: z.number().int(),
  elapsed_human: z.string().describe("Pre-formatted duration: Xh MMm SSs, or Nd HHh MMm SSs for a day or more."),
  elapsed_hours_decimal: z.number().describe("elapsed_seconds / 3600, rounded to 2 decimal places."),
  token: z.string().describe("Fresh token for end_unix, so timings can be chained or checkpointed."),
};

function ok(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Whole seconds since the epoch, read once at the start of a tool call. */
const currentUnix = () => Math.floor(Date.now() / 1000);

/**
 * Build a fresh McpServer. The Worker creates one per request: the server is
 * stateless, so there is nothing to keep between requests.
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Timer for timesheets. Call now() when a conversation starts and keep the token. " +
        "Call elapsed_since(token) to report how long it has run. All times are Unix time in UTC.",
    },
  );

  server.registerTool(
    "now",
    {
      title: "Current Unix time",
      description: NOW_DESCRIPTION,
      outputSchema: nowOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const unix = currentUnix();
      return ok({ unix, iso_utc: isoUtc(unix), token: await makeToken(unix, env.TOKEN_SECRET) });
    },
  );

  server.registerTool(
    "elapsed_since",
    {
      title: "Elapsed time since token",
      description: ELAPSED_SINCE_DESCRIPTION,
      inputSchema: elapsedInput,
      outputSchema: elapsedOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ token }) => {
      const end = currentUnix();
      const verified = await verifyToken(token, env.TOKEN_SECRET, end);
      if (!verified.ok) {
        return toolError(ERROR_MESSAGES[verified.reason]);
      }
      const start = verified.unix;
      const elapsed = end - start;
      return ok({
        start_unix: start,
        start_iso_utc: isoUtc(start),
        end_unix: end,
        end_iso_utc: isoUtc(end),
        elapsed_seconds: elapsed,
        elapsed_human: formatElapsed(elapsed),
        elapsed_hours_decimal: hoursDecimal(elapsed),
        token: await makeToken(end, env.TOKEN_SECRET),
      });
    },
  );

  return server;
}
