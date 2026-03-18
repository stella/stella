import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  toReference,
  toScopeKey,
  validatePattern,
} from "@/api/lib/matter-reference";

describe("validatePattern", () => {
  test("accepts valid patterns", () => {
    expect(Result.isOk(validatePattern("{SEQ}", 3))).toBe(true);
    expect(Result.isOk(validatePattern("{YYYY}/{SEQ}", 3))).toBe(true);
    expect(Result.isOk(validatePattern("{YYYY}-{MM}/{SEQ}", 3))).toBe(true);
    expect(Result.isOk(validatePattern("LIT-{SEQ}", 4))).toBe(true);
    expect(Result.isOk(validatePattern("CORP-{YYYY}-{SEQ}", 3))).toBe(true);
  });

  test("rejects missing {SEQ}", () => {
    const result = validatePattern("{YYYY}", 3);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("{SEQ}");
    }
  });

  test("rejects multiple {SEQ}", () => {
    const result = validatePattern("{SEQ}-{SEQ}", 3);
    expect(Result.isError(result)).toBe(true);
  });

  test("rejects unrecognized tokens", () => {
    const result = validatePattern("{SEQ}-{UNKNOWN}", 3);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("{UNKNOWN}");
    }
  });

  test("rejects forbidden characters", () => {
    expect(Result.isError(validatePattern("<{SEQ}>", 3))).toBe(true);
    expect(Result.isError(validatePattern("{SEQ}&", 3))).toBe(true);
  });

  test("rejects invalid padding", () => {
    expect(Result.isError(validatePattern("{SEQ}", 0))).toBe(true);
    expect(Result.isError(validatePattern("{SEQ}", 7))).toBe(true);
  });

  test("accepts edge padding values", () => {
    expect(Result.isOk(validatePattern("{SEQ}", 1))).toBe(true);
    expect(Result.isOk(validatePattern("{SEQ}", 6))).toBe(true);
  });

  test("rejects patterns that would exceed 64-char reference", () => {
    // 60 literal chars + {SEQ} with padding 6 = 66 chars rendered
    const longPrefix = "A".repeat(60);
    const result = validatePattern(`${longPrefix}{SEQ}`, 6);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("64");
    }
  });

  test("accepts patterns that fit within 64-char reference", () => {
    // 58 literal chars + {SEQ} always reserves 6 = 64 chars
    const prefix = "A".repeat(58);
    expect(Result.isOk(validatePattern(`${prefix}{SEQ}`, 6))).toBe(true);
  });

  test("reserves max padding width for SEQ regardless of padding", () => {
    // 59 literal + {SEQ} reserves 6 = 65 > 64, even with padding=1
    const prefix = "A".repeat(59);
    expect(Result.isError(validatePattern(`${prefix}{SEQ}`, 1))).toBe(true);
  });
});

describe("toScopeKey", () => {
  const feb20 = new Date(2026, 1, 20);

  test("resolves {YYYY}/{SEQ}", () => {
    expect(toScopeKey("{YYYY}/{SEQ}", feb20)).toBe("2026/");
  });

  test("resolves {YYYY}-{MM}/{SEQ}", () => {
    expect(toScopeKey("{YYYY}-{MM}/{SEQ}", feb20)).toBe("2026-02/");
  });

  test("resolves LIT-{SEQ}", () => {
    expect(toScopeKey("LIT-{SEQ}", feb20)).toBe("LIT-");
  });

  test("resolves bare {SEQ}", () => {
    expect(toScopeKey("{SEQ}", feb20)).toBe("");
  });

  test("resolves {YY}", () => {
    expect(toScopeKey("{YY}-{SEQ}", feb20)).toBe("26-");
  });

  test("resolves CORP-{YYYY}-{SEQ}", () => {
    expect(toScopeKey("CORP-{YYYY}-{SEQ}", feb20)).toBe("CORP-2026-");
  });

  test("resolves duplicate date tokens", () => {
    expect(toScopeKey("{YYYY}-{YYYY}/{SEQ}", feb20)).toBe("2026-2026/");
  });

  test("year rollover produces different scope key", () => {
    const dec31 = new Date(2025, 11, 31);
    const jan1 = new Date(2026, 0, 1);
    const pattern = "{YYYY}/{SEQ}";
    expect(toScopeKey(pattern, dec31)).toBe("2025/");
    expect(toScopeKey(pattern, jan1)).toBe("2026/");
    // Different scope keys mean counters reset
    expect(toScopeKey(pattern, dec31)).not.toBe(toScopeKey(pattern, jan1));
  });

  test("month rollover produces different scope key", () => {
    const jan = new Date(2026, 0, 15);
    const feb = new Date(2026, 1, 15);
    const pattern = "{YYYY}-{MM}/{SEQ}";
    expect(toScopeKey(pattern, jan)).toBe("2026-01/");
    expect(toScopeKey(pattern, feb)).toBe("2026-02/");
  });

  test("pattern without date tokens has stable scope key", () => {
    const jan = new Date(2026, 0, 1);
    const dec = new Date(2026, 11, 31);
    const pattern = "LIT-{SEQ}";
    // Same scope key regardless of date, so counter never resets
    expect(toScopeKey(pattern, jan)).toBe(toScopeKey(pattern, dec));
  });
});

describe("toReference", () => {
  const feb20 = new Date(2026, 1, 20);

  test("pads sequence to specified width", () => {
    expect(
      toReference({ pattern: "{YYYY}/{SEQ}", now: feb20, seq: 1, padding: 3 }),
    ).toBe("2026/001");
    expect(
      toReference({ pattern: "{YYYY}/{SEQ}", now: feb20, seq: 42, padding: 3 }),
    ).toBe("2026/042");
    expect(
      toReference({
        pattern: "{YYYY}/{SEQ}",
        now: feb20,
        seq: 1000,
        padding: 3,
      }),
    ).toBe("2026/1000");
  });

  test("works with bare {SEQ}", () => {
    expect(
      toReference({ pattern: "{SEQ}", now: feb20, seq: 1, padding: 3 }),
    ).toBe("001");
    expect(
      toReference({ pattern: "{SEQ}", now: feb20, seq: 999, padding: 3 }),
    ).toBe("999");
  });

  test("works with literal prefix", () => {
    expect(
      toReference({ pattern: "LIT-{SEQ}", now: feb20, seq: 1, padding: 4 }),
    ).toBe("LIT-0001");
  });

  test("respects different padding", () => {
    expect(
      toReference({ pattern: "{SEQ}", now: feb20, seq: 1, padding: 1 }),
    ).toBe("1");
    expect(
      toReference({ pattern: "{SEQ}", now: feb20, seq: 1, padding: 6 }),
    ).toBe("000001");
  });

  test("handles {SEQ} in non-terminal position", () => {
    expect(
      toReference({
        pattern: "CORP-{SEQ}-{YYYY}",
        now: feb20,
        seq: 1,
        padding: 3,
      }),
    ).toBe("CORP-001-2026");
    expect(
      toReference({ pattern: "{SEQ}/{YYYY}", now: feb20, seq: 1, padding: 3 }),
    ).toBe("001/2026");
    expect(
      toReference({
        pattern: "{SEQ}-{YYYY}-{MM}",
        now: feb20,
        seq: 42,
        padding: 3,
      }),
    ).toBe("042-2026-02");
  });

  test("padding overflow: seq exceeds padding width", () => {
    // padStart only sets a minimum; larger numbers are not truncated
    expect(
      toReference({ pattern: "{SEQ}", now: feb20, seq: 9999, padding: 3 }),
    ).toBe("9999");
    expect(
      toReference({
        pattern: "{YYYY}/{SEQ}",
        now: feb20,
        seq: 100_000,
        padding: 3,
      }),
    ).toBe("2026/100000");
  });

  test("year rollover changes the rendered reference", () => {
    const dec = new Date(2025, 11, 31);
    const jan = new Date(2026, 0, 1);
    // Same seq but different date yields different reference
    expect(
      toReference({ pattern: "{YYYY}/{SEQ}", now: dec, seq: 1, padding: 3 }),
    ).toBe("2025/001");
    expect(
      toReference({ pattern: "{YYYY}/{SEQ}", now: jan, seq: 1, padding: 3 }),
    ).toBe("2026/001");
  });
});
