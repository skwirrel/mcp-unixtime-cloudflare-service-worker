/**
 * Optional local-time presentation. The zone is an IANA name (e.g. Europe/London)
 * supplied per request via `?tz=` or per deployment via DEFAULT_TIMEZONE. It never
 * affects tokens or arithmetic: everything is still Unix time underneath. Formatting
 * uses the runtime's ICU data, so DST rules come for free.
 */

const cache = new Map<string, { iso: Intl.DateTimeFormat; human: Intl.DateTimeFormat }>();

/**
 * Zone abbreviations (BST, EDT, AEST) are locale data, not zone data: en-GB knows BST but
 * renders New York as "GMT-4", and en-US the reverse. Pick the locale by region so the
 * abbreviation is the one people there actually use; everything else falls back to en-GB.
 */
function localeFor(timeZone: string): string {
  if (timeZone.startsWith("America/") || timeZone.startsWith("US/") || timeZone.startsWith("Pacific/Honolulu")) return "en-US";
  if (timeZone.startsWith("Australia/")) return "en-AU";
  if (timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta") return "en-IN";
  return "en-GB";
}

function formatters(timeZone: string) {
  let f = cache.get(timeZone);
  if (!f) {
    const locale = localeFor(timeZone);
    f = {
      iso: new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      }),
      human: new Intl.DateTimeFormat(locale, {
        timeZone,
        weekday: "short", day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }),
    };
    cache.set(timeZone, f);
  }
  return f;
}

/** Canonical IANA name if the runtime knows the zone, otherwise null. */
export function canonicalTimeZone(tz: string): string | null {
  const trimmed = tz.trim();
  if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export type TimeZoneChoice = { ok: true; timeZone: string | undefined } | { ok: false };

/**
 * `?tz=` on the request wins; otherwise the deployment default; otherwise none.
 * An empty value in either place counts as "not set".
 */
export function chooseTimeZone(url: URL, defaultTimeZone: string | undefined): TimeZoneChoice {
  const raw = url.searchParams.get("tz") ?? defaultTimeZone ?? "";
  if (raw.trim() === "") return { ok: true, timeZone: undefined };
  const tz = canonicalTimeZone(raw);
  return tz ? { ok: true, timeZone: tz } : { ok: false };
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** RFC 3339 local time with numeric offset, e.g. 2026-10-09T11:32:07+01:00. */
export function localIso(unix: number, timeZone: string): string {
  const parts = formatters(timeZone).iso.formatToParts(new Date(unix * 1000));
  const name = part(parts, "timeZoneName"); // "GMT", "GMT+01:00", "GMT-05:00", "GMT+05:30"
  const m = /^GMT([+-]\d{2}:\d{2})?$/.exec(name);
  const offset = m?.[1] ?? "+00:00";
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}T${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}${offset}`;
}

/** Readable local time with zone abbreviation, e.g. "Fri 9 Oct 2026, 11:32:07 BST". */
export function localHuman(unix: number, timeZone: string): string {
  const parts = formatters(timeZone).human.formatToParts(new Date(unix * 1000));
  return `${part(parts, "weekday")} ${part(parts, "day")} ${part(parts, "month")} ${part(parts, "year")}, ` +
    `${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")} ${part(parts, "timeZoneName")}`;
}
