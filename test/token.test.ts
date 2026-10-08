import { describe, expect, it } from "vitest";
import { makeToken, signUnix, verifyToken } from "../src/token";

const SECRET = "unit-test-secret";

describe("token", () => {
  it("is <unix>.<8 lowercase hex> and deterministic for a secret", async () => {
    const a = await makeToken(1791381600, SECRET);
    const b = await makeToken(1791381600, SECRET);
    expect(a).toMatch(/^\d{1,12}\.[0-9a-f]{8}$/);
    expect(a).toBe(b);
    expect(a.startsWith("1791381600.")).toBe(true);
  });

  it("differs between secrets and between times", async () => {
    expect(await signUnix(1791381600, SECRET)).not.toBe(await signUnix(1791381600, SECRET + "x"));
    expect(await signUnix(1791381600, SECRET)).not.toBe(await signUnix(1791381601, SECRET));
  });

  it("verifies a genuine token", async () => {
    const t = await makeToken(1791381600, SECRET);
    expect(await verifyToken(t, SECRET, 1791381600 + 10)).toEqual({ ok: true, unix: 1791381600 });
  });

  it("accepts up to 60 seconds of clock skew into the future, no more", async () => {
    const now = 1791381600;
    expect((await verifyToken(await makeToken(now + 60, SECRET), SECRET, now)).ok).toBe(true);
    expect(await verifyToken(await makeToken(now + 61, SECRET), SECRET, now)).toEqual({
      ok: false,
      reason: "future",
    });
  });

  it("rejects malformed tokens before checking anything else", async () => {
    for (const bad of ["", "abc", "1791381600", "1791381600.", "1791381600.abc", "1791381600.ABCDEF01",
      "1791381600.0123456789", "1791381600.0123456g", " 1791381600.01234567", "1234567890123.01234567",
      "-1.01234567", "1791381600.01234567\n"]) {
      expect(await verifyToken(bad, SECRET, 1791381600), bad).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a token signed with another secret", async () => {
    const t = await makeToken(1791381600, "other");
    expect(await verifyToken(t, SECRET, 1791381600)).toEqual({ ok: false, reason: "bad_signature" });
  });
});
