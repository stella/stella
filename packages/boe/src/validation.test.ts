import { describe, expect, test } from "bun:test";

import { toBoeDate, validateBoeDate, validateLawId } from "./validation.js";

describe("validateLawId", () => {
  test("accepts known-good real BOE identifiers", () => {
    // Código Civil (1889) and a modern entry; both used in the live client tests.
    expect(validateLawId("BOE-A-1889-4763")).toBe(true);
    expect(validateLawId("BOE-A-2026-10510")).toBe(true);
  });

  test("accepts every uppercase section letter for forward compatibility", () => {
    for (let code = 0x41; code <= 0x5a; code++) {
      const letter = String.fromCharCode(code);
      expect(validateLawId(`BOE-${letter}-2026-1`)).toBe(true);
    }
  });

  test("rejects lowercase section letters", () => {
    expect(validateLawId("BOE-a-1889-4763")).toBe(false);
  });

  test("rejects a multi-character section field", () => {
    expect(validateLawId("BOE-AB-1889-4763")).toBe(false);
  });

  test("rejects a year that is not exactly four digits", () => {
    expect(validateLawId("BOE-A-889-4763")).toBe(false);
    expect(validateLawId("BOE-A-18890-4763")).toBe(false);
  });

  test("rejects an empty sequence number", () => {
    expect(validateLawId("BOE-A-1889-")).toBe(false);
  });

  test("rejects non-digit characters in the sequence number", () => {
    expect(validateLawId("BOE-A-1889-47A3")).toBe(false);
  });

  test("rejects a wrong prefix", () => {
    expect(validateLawId("DOE-A-1889-4763")).toBe(false);
    expect(validateLawId("boe-A-1889-4763")).toBe(false);
  });

  test("rejects identifiers with leading or trailing whitespace (anchored pattern)", () => {
    expect(validateLawId(" BOE-A-1889-4763")).toBe(false);
    expect(validateLawId("BOE-A-1889-4763 ")).toBe(false);
    expect(validateLawId("BOE-A-1889-4763\n")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(validateLawId("")).toBe(false);
  });

  test("invariant: any string matching the canonical shape validates", () => {
    const letters = "ABCSTXYZ";
    for (let i = 0; i < 200; i++) {
      const letter = letters[Math.floor(Math.random() * letters.length)];
      const year = String(1960 + Math.floor(Math.random() * 141)).padStart(
        4,
        "0",
      );
      const seqLength = 1 + Math.floor(Math.random() * 6);
      let seq = "";
      for (let s = 0; s < seqLength; s++) {
        seq += String(Math.floor(Math.random() * 10));
      }
      expect(validateLawId(`BOE-${letter}-${year}-${seq}`)).toBe(true);
    }
  });
});

describe("validateBoeDate", () => {
  test("accepts well-formed in-range compact dates", () => {
    expect(validateBoeDate("20260510")).toBe(true);
    expect(validateBoeDate("19600101")).toBe(true);
    expect(validateBoeDate("21001231")).toBe(true);
  });

  test("rejects dates whose length is not eight digits", () => {
    expect(validateBoeDate("2026051")).toBe(false);
    expect(validateBoeDate("202605100")).toBe(false);
    expect(validateBoeDate("")).toBe(false);
  });

  test("rejects non-digit characters", () => {
    expect(validateBoeDate("2026-5-10")).toBe(false);
    expect(validateBoeDate("2026051a")).toBe(false);
  });

  test("rejects an out-of-range month", () => {
    expect(validateBoeDate("20260010")).toBe(false);
    expect(validateBoeDate("20261310")).toBe(false);
  });

  test("rejects an out-of-range day", () => {
    expect(validateBoeDate("20260500")).toBe(false);
    expect(validateBoeDate("20260532")).toBe(false);
  });

  test("rejects years outside the supported window", () => {
    expect(validateBoeDate("19591231")).toBe(false);
    expect(validateBoeDate("21010101")).toBe(false);
  });

  test("shape-only: accepts calendar-impossible but in-range day/month combos", () => {
    // The validator deliberately checks shape, not calendar existence.
    expect(validateBoeDate("20260231")).toBe(true);
    expect(validateBoeDate("20260431")).toBe(true);
  });
});

describe("toBoeDate", () => {
  test("strips dashes from an ISO date", () => {
    expect(toBoeDate("2026-05-10")).toBe("20260510");
  });

  test("passes through an already-compact date unchanged", () => {
    expect(toBoeDate("20260510")).toBe("20260510");
  });

  test("removes every dash, not just the first", () => {
    expect(toBoeDate("1889-01-01")).toBe("18890101");
  });

  test("invariant: ISO dates round-trip into dates the validator accepts", () => {
    for (let i = 0; i < 100; i++) {
      const year = 1960 + Math.floor(Math.random() * 141);
      const month = 1 + Math.floor(Math.random() * 12);
      const day = 1 + Math.floor(Math.random() * 28);
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const compact = toBoeDate(iso);
      expect(compact).toBe(iso.replaceAll("-", ""));
      expect(validateBoeDate(compact)).toBe(true);
    }
  });
});
