export interface Env {
  /** Shared secret for header and path authentication. */
  AUTH_SECRET: string;
  /** HMAC key for timestamp tokens. Separate from AUTH_SECRET so they rotate independently. */
  TOKEN_SECRET: string;
  /** Enables the `/mcp/<AUTH_SECRET>` route. Anything other than "false" (or false) enables it. */
  ALLOW_PATH_SECRET?: string | boolean;
  /** Workers rate limiting binding, keyed on client IP. */
  RATE_LIMITER: RateLimit;
  /** Optional IANA zone (e.g. Europe/London) for local-time fields. `?tz=` on the URL overrides it. */
  DEFAULT_TIMEZONE?: string;
}

export function pathSecretAllowed(env: Env): boolean {
  const v = env.ALLOW_PATH_SECRET;
  if (v === undefined || v === null) return true;
  return String(v).trim().toLowerCase() !== "false";
}
