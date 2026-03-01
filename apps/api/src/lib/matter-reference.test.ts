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
});

describe("toReference", () => {
  const feb20 = new Date(2026, 1, 20);

  test("pads sequence to specified width", () => {
    expect(toReference("{YYYY}/{SEQ}", feb20, 1, 3)).toBe("2026/001");
    expect(toReference("{YYYY}/{SEQ}", feb20, 42, 3)).toBe("2026/042");
    expect(toReference("{YYYY}/{SEQ}", feb20, 1000, 3)).toBe("2026/1000");
  });

  test("works with bare {SEQ}", () => {
    expect(toReference("{SEQ}", feb20, 1, 3)).toBe("001");
    expect(toReference("{SEQ}", feb20, 999, 3)).toBe("999");
  });

  test("works with literal prefix", () => {
    expect(toReference("LIT-{SEQ}", feb20, 1, 4)).toBe("LIT-0001");
  });

  test("respects different padding", () => {
    expect(toReference("{SEQ}", feb20, 1, 1)).toBe("1");
    expect(toReference("{SEQ}", feb20, 1, 6)).toBe("000001");
  });

  test("handles {SEQ} in non-terminal position", () => {
    expect(toReference("CORP-{SEQ}-{YYYY}", feb20, 1, 3)).toBe("CORP-001-2026");
    expect(toReference("{SEQ}/{YYYY}", feb20, 1, 3)).toBe("001/2026");
    expect(toReference("{SEQ}-{YYYY}-{MM}", feb20, 42, 3)).toBe("042-2026-02");
  });
});
