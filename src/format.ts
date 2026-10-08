const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * `Xh MMm SSs` under 24 hours, `Nd HHh MMm SSs` at 24 hours or more.
 * Minutes and seconds are always zero-padded; hours are padded only in the day form.
 */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const seconds = s % 60;
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600);
  if (hours < 24) {
    return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${pad2(hours % 24)}h ${pad2(minutes)}m ${pad2(seconds)}s`;
}

/** Seconds as decimal hours, rounded to two places. */
export function hoursDecimal(totalSeconds: number): number {
  return Math.round((totalSeconds / 3600) * 100) / 100;
}

/** ISO 8601 UTC without fractional seconds, e.g. 2026-10-07T14:00:00Z. */
export function isoUtc(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
