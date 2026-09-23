import { describe, expect, test } from "bun:test";

import {
  matchesMatterReferencePattern,
  renderMatterReference,
} from "./matter-reference";

describe("matchesMatterReferencePattern", () => {
  test("default {SEQ} pattern accepts any digit string at least padding wide", () => {
    expect(matchesMatterReferencePattern("1", "{SEQ}", 1)).toBe(true);
    expect(matchesMatterReferencePattern("001", "{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("1234", "{SEQ}", 3)).toBe(true);
  });

  test("default {SEQ} pattern rejects non-digit strings", () => {
    expect(matchesMatterReferencePattern("abc", "{SEQ}", 3)).toBe(false);
    expect(matchesMatterReferencePattern("", "{SEQ}", 3)).toBe(false);
    expect(matchesMatterReferencePattern("1a", "{SEQ}", 3)).toBe(false);
  });

  test("padding enforces minimum width", () => {
    expect(matchesMatterReferencePattern("01", "{SEQ}", 3)).toBe(false);
    expect(matchesMatterReferencePattern("001", "{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("9999", "{SEQ}", 3)).toBe(true);
  });

  test("year/seq pattern", () => {
    expect(matchesMatterReferencePattern("2026/001", "{YYYY}/{SEQ}", 3)).toBe(
      true,
    );
    expect(matchesMatterReferencePattern("2025/1234", "{YYYY}/{SEQ}", 3)).toBe(
      true,
    );
    expect(matchesMatterReferencePattern("26/001", "{YYYY}/{SEQ}", 3)).toBe(
      false,
    );
    expect(matchesMatterReferencePattern("2026-001", "{YYYY}/{SEQ}", 3)).toBe(
      false,
    );
  });

  test("year-month/seq enforces valid month", () => {
    expect(
      matchesMatterReferencePattern("2026-02/001", "{YYYY}-{MM}/{SEQ}", 3),
    ).toBe(true);
    expect(
      matchesMatterReferencePattern("2026-12/001", "{YYYY}-{MM}/{SEQ}", 3),
    ).toBe(true);
    expect(
      matchesMatterReferencePattern("2026-13/001", "{YYYY}-{MM}/{SEQ}", 3),
    ).toBe(false);
    expect(
      matchesMatterReferencePattern("2026-00/001", "{YYYY}-{MM}/{SEQ}", 3),
    ).toBe(false);
  });

  test("literal prefix", () => {
    expect(matchesMatterReferencePattern("MAT-001", "MAT-{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("mat-001", "MAT-{SEQ}", 3)).toBe(
      false,
    );
    expect(matchesMatterReferencePattern("MAT-1", "MAT-{SEQ}", 3)).toBe(false);
  });

  test("regex meta in literal segments are escaped", () => {
    expect(matchesMatterReferencePattern("A.B-001", "A.B-{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("AXB-001", "A.B-{SEQ}", 3)).toBe(
      false,
    );
    expect(matchesMatterReferencePattern("A+B-001", "A+B-{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("AB-001", "A+B-{SEQ}", 3)).toBe(false);
  });

  test("two-digit year token", () => {
    expect(matchesMatterReferencePattern("26/001", "{YY}/{SEQ}", 3)).toBe(true);
    expect(matchesMatterReferencePattern("2026/001", "{YY}/{SEQ}", 3)).toBe(
      false,
    );
  });
});

describe("renderMatterReference with the first sequence", () => {
  test("renders current year and zero-padded seq=1", () => {
    const now = new Date(2026, 1, 20);
    expect(
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        padding: 3,
        now,
        seq: 1,
      }),
    ).toBe("2026/001");
    expect(
      renderMatterReference({
        pattern: "{YYYY}-{MM}/{SEQ}",
        padding: 3,
        now,
        seq: 1,
      }),
    ).toBe("2026-02/001");
    expect(
      renderMatterReference({ pattern: "MAT-{SEQ}", padding: 4, now, seq: 1 }),
    ).toBe("MAT-0001");
  });

  test("two-digit year", () => {
    const now = new Date(2026, 5, 1);
    expect(
      renderMatterReference({ pattern: "{YY}/{SEQ}", padding: 3, now, seq: 1 }),
    ).toBe("26/001");
  });
});

describe("renderMatterReference", () => {
  const feb20 = new Date(2026, 1, 20);

  test("pads sequence to specified width", () => {
    expect(
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        now: feb20,
        seq: 1,
        padding: 3,
      }),
    ).toBe("2026/001");
    expect(
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        now: feb20,
        seq: 42,
        padding: 3,
      }),
    ).toBe("2026/042");
    expect(
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        now: feb20,
        seq: 1000,
        padding: 3,
      }),
    ).toBe("2026/1000");
  });

  test("works with bare {SEQ}", () => {
    expect(
      renderMatterReference({
        pattern: "{SEQ}",
        now: feb20,
        seq: 1,
        padding: 3,
      }),
    ).toBe("001");
    expect(
      renderMatterReference({
        pattern: "{SEQ}",
        now: feb20,
        seq: 999,
        padding: 3,
      }),
    ).toBe("999");
  });

  test("works with literal prefix", () => {
    expect(
      renderMatterReference({
        pattern: "LIT-{SEQ}",
        now: feb20,
        seq: 1,
        padding: 4,
      }),
    ).toBe("LIT-0001");
  });

  test("respects different padding", () => {
    expect(
      renderMatterReference({
        pattern: "{SEQ}",
        now: feb20,
        seq: 1,
        padding: 1,
      }),
    ).toBe("1");
    expect(
      renderMatterReference({
        pattern: "{SEQ}",
        now: feb20,
        seq: 1,
        padding: 6,
      }),
    ).toBe("000001");
  });

  test("handles {SEQ} in non-terminal position", () => {
    expect(
      renderMatterReference({
        pattern: "CORP-{SEQ}-{YYYY}",
        now: feb20,
        seq: 1,
        padding: 3,
      }),
    ).toBe("CORP-001-2026");
    expect(
      renderMatterReference({
        pattern: "{SEQ}/{YYYY}",
        now: feb20,
        seq: 1,
        padding: 3,
      }),
    ).toBe("001/2026");
    expect(
      renderMatterReference({
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
      renderMatterReference({
        pattern: "{SEQ}",
        now: feb20,
        seq: 9999,
        padding: 3,
      }),
    ).toBe("9999");
    expect(
      renderMatterReference({
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
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        now: dec,
        seq: 1,
        padding: 3,
      }),
    ).toBe("2025/001");
    expect(
      renderMatterReference({
        pattern: "{YYYY}/{SEQ}",
        now: jan,
        seq: 1,
        padding: 3,
      }),
    ).toBe("2026/001");
  });
});
