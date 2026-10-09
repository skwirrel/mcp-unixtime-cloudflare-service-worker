import { describe, expect, it } from "vitest";
import { canonicalTimeZone, chooseTimeZone, localHuman, localIso } from "../src/timezone";

const JAN = 1767268800; // 2026-01-01T12:00:00Z
const JUL = 1782907200; // 2026-07-01T12:00:00Z

describe("localIso", () => {
  it("applies UK DST either side of the clock change", () => {
    expect(localIso(JAN, "Europe/London")).toBe("2026-01-01T12:00:00+00:00");
    expect(localIso(JUL, "Europe/London")).toBe("2026-07-01T13:00:00+01:00");
  });

  it("handles negative and half-hour offsets", () => {
    expect(localIso(JAN, "America/New_York")).toBe("2026-01-01T07:00:00-05:00");
    expect(localIso(JUL, "America/New_York")).toBe("2026-07-01T08:00:00-04:00");
    expect(localIso(JAN, "Asia/Kolkata")).toBe("2026-01-01T17:30:00+05:30");
    expect(localIso(JAN, "Australia/Adelaide")).toBe("2026-01-01T22:30:00+10:30");
    expect(localIso(JUL, "Australia/Adelaide")).toBe("2026-07-01T21:30:00+09:30");
  });

  it("crosses the date line correctly", () => {
    expect(localIso(1767308400, "Pacific/Auckland")).toBe("2026-01-02T12:00:00+13:00"); // 2026-01-01T23:00Z
    expect(localIso(JAN, "UTC")).toBe("2026-01-01T12:00:00+00:00");
  });
});

describe("localHuman", () => {
  it("is readable and carries the zone abbreviation", () => {
    expect(localHuman(JAN, "Europe/London")).toBe("Thu 1 Jan 2026, 12:00:00 GMT");
    expect(localHuman(JUL, "Europe/London")).toBe("Wed 1 Jul 2026, 13:00:00 BST");
    expect(localHuman(JUL, "America/New_York")).toBe("Wed 1 Jul 2026, 08:00:00 EDT");
    expect(localHuman(JAN, "America/Los_Angeles")).toBe("Thu 1 Jan 2026, 04:00:00 PST");
    expect(localHuman(JAN, "Australia/Sydney")).toBe("Thu 1 Jan 2026, 23:00:00 AEDT");
    expect(localHuman(JAN, "Asia/Kolkata")).toBe("Thu 1 Jan 2026, 17:30:00 IST");
  });
});

describe("canonicalTimeZone", () => {
  it("accepts known zones and canonicalises case", () => {
    expect(canonicalTimeZone("Europe/London")).toBe("Europe/London");
    expect(canonicalTimeZone("europe/london")).toBe("Europe/London");
    expect(canonicalTimeZone(" UTC ")).toBe("UTC");
  });

  it("rejects unknown or malformed names", () => {
    for (const bad of ["", "Europe/Hebden_Bridge", "Mars/Olympus", "GMT+1 ", "<script>", "a".repeat(65), "Europe London"]) {
      expect(canonicalTimeZone(bad), bad).toBeNull();
    }
  });
});

describe("chooseTimeZone", () => {
  const u = (q = "") => new URL(`https://x.test/mcp${q}`);

  it("uses the URL parameter first, then the default, then nothing", () => {
    expect(chooseTimeZone(u("?tz=Asia/Tokyo"), "Europe/London")).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
    expect(chooseTimeZone(u(), "Europe/London")).toEqual({ ok: true, timeZone: "Europe/London" });
    expect(chooseTimeZone(u(), undefined)).toEqual({ ok: true, timeZone: undefined });
    expect(chooseTimeZone(u(), "")).toEqual({ ok: true, timeZone: undefined });
    expect(chooseTimeZone(u("?tz="), "Europe/London")).toEqual({ ok: true, timeZone: undefined });
  });

  it("flags an invalid zone from either source", () => {
    expect(chooseTimeZone(u("?tz=Nowhere/Land"), "Europe/London")).toEqual({ ok: false });
    expect(chooseTimeZone(u(), "Nowhere/Land")).toEqual({ ok: false });
  });
});
