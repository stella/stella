import { describe, expect, test } from "bun:test";

import { matchesPattern, previewReference } from "@/lib/matter-reference";

describe("matchesPattern", () => {
  test("default {SEQ} pattern accepts any digit string at least padding wide", () => {
    expect(matchesPattern("1", "{SEQ}", 1)).toBe(true);
    expect(matchesPattern("001", "{SEQ}", 3)).toBe(true);
    expect(matchesPattern("1234", "{SEQ}", 3)).toBe(true);
  });

  test("default {SEQ} pattern rejects non-digit strings", () => {
    expect(matchesPattern("abc", "{SEQ}", 3)).toBe(false);
    expect(matchesPattern("", "{SEQ}", 3)).toBe(false);
    expect(matchesPattern("1a", "{SEQ}", 3)).toBe(false);
  });

  test("padding enforces minimum width", () => {
    expect(matchesPattern("01", "{SEQ}", 3)).toBe(false);
    expect(matchesPattern("001", "{SEQ}", 3)).toBe(true);
    expect(matchesPattern("9999", "{SEQ}", 3)).toBe(true);
  });

  test("year/seq pattern", () => {
    expect(matchesPattern("2026/001", "{YYYY}/{SEQ}", 3)).toBe(true);
    expect(matchesPattern("2025/1234", "{YYYY}/{SEQ}", 3)).toBe(true);
    expect(matchesPattern("26/001", "{YYYY}/{SEQ}", 3)).toBe(false);
    expect(matchesPattern("2026-001", "{YYYY}/{SEQ}", 3)).toBe(false);
  });

  test("year-month/seq enforces valid month", () => {
    expect(matchesPattern("2026-02/001", "{YYYY}-{MM}/{SEQ}", 3)).toBe(true);
    expect(matchesPattern("2026-12/001", "{YYYY}-{MM}/{SEQ}", 3)).toBe(true);
    expect(matchesPattern("2026-13/001", "{YYYY}-{MM}/{SEQ}", 3)).toBe(false);
    expect(matchesPattern("2026-00/001", "{YYYY}-{MM}/{SEQ}", 3)).toBe(false);
  });

  test("literal prefix", () => {
    expect(matchesPattern("MAT-001", "MAT-{SEQ}", 3)).toBe(true);
    expect(matchesPattern("mat-001", "MAT-{SEQ}", 3)).toBe(false);
    expect(matchesPattern("MAT-1", "MAT-{SEQ}", 3)).toBe(false);
  });

  test("regex meta in literal segments are escaped", () => {
    expect(matchesPattern("A.B-001", "A.B-{SEQ}", 3)).toBe(true);
    expect(matchesPattern("AXB-001", "A.B-{SEQ}", 3)).toBe(false);
    expect(matchesPattern("A+B-001", "A+B-{SEQ}", 3)).toBe(true);
    expect(matchesPattern("AB-001", "A+B-{SEQ}", 3)).toBe(false);
  });

  test("two-digit year token", () => {
    expect(matchesPattern("26/001", "{YY}/{SEQ}", 3)).toBe(true);
    expect(matchesPattern("2026/001", "{YY}/{SEQ}", 3)).toBe(false);
  });
});

describe("previewReference", () => {
  test("renders current year and zero-padded seq=1", () => {
    const now = new Date(2026, 1, 20);
    expect(previewReference({ pattern: "{YYYY}/{SEQ}", padding: 3, now })).toBe(
      "2026/001",
    );
    expect(
      previewReference({ pattern: "{YYYY}-{MM}/{SEQ}", padding: 3, now }),
    ).toBe("2026-02/001");
    expect(previewReference({ pattern: "MAT-{SEQ}", padding: 4, now })).toBe(
      "MAT-0001",
    );
  });

  test("two-digit year", () => {
    const now = new Date(2026, 5, 1);
    expect(previewReference({ pattern: "{YY}/{SEQ}", padding: 3, now })).toBe(
      "26/001",
    );
  });
});
