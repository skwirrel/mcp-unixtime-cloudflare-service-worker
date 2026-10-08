import { describe, expect, it } from "vitest";
import { formatElapsed, hoursDecimal, isoUtc } from "../src/format";

describe("formatElapsed", () => {
  it("formats under 24 hours as Xh MMm SSs with zero-padded minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0h 00m 00s");
    expect(formatElapsed(1)).toBe("0h 00m 01s");
    expect(formatElapsed(59)).toBe("0h 00m 59s");
    expect(formatElapsed(60)).toBe("0h 01m 00s");
    expect(formatElapsed(5527)).toBe("1h 32m 07s");
    expect(formatElapsed(36000)).toBe("10h 00m 00s");
    expect(formatElapsed(86399)).toBe("23h 59m 59s");
  });

  it("formats 24 hours or more as Nd HHh MMm SSs", () => {
    expect(formatElapsed(86400)).toBe("1d 00h 00m 00s");
    expect(formatElapsed(90061)).toBe("1d 01h 01m 01s");
    expect(formatElapsed(86400 * 3 + 23 * 3600 + 59 * 60 + 59)).toBe("3d 23h 59m 59s");
    expect(formatElapsed(86400 * 12)).toBe("12d 00h 00m 00s");
  });

  it("never goes negative", () => {
    expect(formatElapsed(-5)).toBe("0h 00m 00s");
  });
});

describe("hoursDecimal", () => {
  it("is seconds / 3600 to two decimal places", () => {
    expect(hoursDecimal(0)).toBe(0);
    expect(hoursDecimal(1800)).toBe(0.5);
    expect(hoursDecimal(5527)).toBe(1.54);
    expect(hoursDecimal(3600)).toBe(1);
    expect(hoursDecimal(18)).toBe(0.01);
    expect(hoursDecimal(17)).toBe(0);
  });
});

describe("isoUtc", () => {
  it("prints whole-second ISO 8601 in UTC", () => {
    expect(isoUtc(1791381600)).toBe("2026-10-07T14:00:00Z");
    expect(isoUtc(0)).toBe("1970-01-01T00:00:00Z");
  });
});
