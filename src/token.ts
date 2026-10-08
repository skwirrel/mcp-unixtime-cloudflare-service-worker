import { timingSafeEqual } from "./compare";

/** `<unix>.<sig>`: up to 12 decimal digits, a dot, 8 lowercase hex chars. */
export const TOKEN_PATTERN = "^\\d{1,12}\\.[0-9a-f]{8}$";
const TOKEN_RE = new RegExp(TOKEN_PATTERN);

/** Tokens dated more than this far ahead of the server clock are rejected. */
export const MAX_FUTURE_SKEW_SECONDS = 60;

const SIG_HEX_CHARS = 8;

// One imported key per isolate per secret. Keyed on the secret so that a
// rotated TOKEN_SECRET takes effect without a stale cache.
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache.set(secret, key);
  return key;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 8 hex chars of HMAC-SHA256(secret, String(unix)). */
export async function signUnix(unix: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(unix)));
  return toHex(mac).slice(0, SIG_HEX_CHARS);
}

export async function makeToken(unix: number, secret: string): Promise<string> {
  return `${unix}.${await signUnix(unix, secret)}`;
}

export type VerifyFailure = "malformed" | "bad_signature" | "future";

export type VerifyResult = { ok: true; unix: number } | { ok: false; reason: VerifyFailure };

/**
 * Verify a token against the secret and the current time.
 * Checks run in order: format, signature, then future-dating.
 */
export async function verifyToken(token: string, secret: string, nowUnix: number): Promise<VerifyResult> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { ok: false, reason: "malformed" };
  }
  const [unixStr, sig] = token.split(".");
  const unix = Number(unixStr);
  const expected = await signUnix(unix, secret);
  if (!timingSafeEqual(sig, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (unix > nowUnix + MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "future" };
  }
  return { ok: true, unix };
}
