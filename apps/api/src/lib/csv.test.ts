import { describe, expect, test } from "bun:test";

import { escapeCSV } from "@/api/lib/csv";

/**
 * Minimal RFC 4180 single-field reader: given the text of one CSV cell as
 * `escapeCSV` would emit it, recover the logical value a conformant parser
 * (Excel, Numbers, LibreOffice, csv-parse) would read back.
 *
 * This is deliberately independent of `escapeCSV`'s implementation so the
 * roundtrip assertions below test the *contract*, not the code.
 */
const readCsvField = (cell: string): string => {
  if (!cell.startsWith('"')) {
    return cell;
  }
  let out = "";
  let i = 1;
  while (i < cell.length) {
    const ch = cell[i];
    if (ch === '"') {
      if (cell[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      // closing quote; RFC 4180 has nothing after it for a lone field
      return out;
    }
    out += ch;
    i += 1;
  }
  return out;
};

const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/u;

// Deterministic LCG so a fuzz failure is reproducible, never flaky.
const LCG_MODULUS = 2 ** 32;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;

const makePrng = (seed: number) => {
  let state = Math.trunc(seed) % LCG_MODULUS;
  if (state < 0) {
    state += LCG_MODULUS;
  }
  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
};

const FUZZ_ALPHABET = [
  "a",
  "Z",
  "9",
  " ",
  ",",
  '"',
  "\n",
  "\r",
  "\t",
  "=",
  "+",
  "-",
  "@",
  "|",
  "š",
  "字",
  "=SUM(",
  "()",
];

describe("escapeCSV", () => {
  test("passes through plain values unchanged", () => {
    for (const v of ["", "abc", "John Smith", "123.45", "Praha 1", "café"]) {
      expect(escapeCSV(v)).toBe(v);
    }
  });

  test("quotes and doubles inner quotes for delimiter-bearing values", () => {
    expect(escapeCSV("a,b")).toBe('"a,b"');
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCSV("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCSV("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  test("neutralizes spreadsheet formula prefixes with a leading tab", () => {
    // The classic CSV-injection vectors must never reach a cell that a
    // spreadsheet would evaluate as a formula.
    for (const v of [
      "=1+1",
      "+1",
      "-1+cmd",
      "@SUM(A1)",
      "=HYPERLINK(...)",
      "\t=evil",
    ]) {
      const escaped = escapeCSV(v);
      expect(escaped.startsWith('"\t')).toBe(true);
    }
  });

  test("neutralizes formula prefixes even behind leading whitespace", () => {
    // Excel trims leading spaces before deciding a cell is a formula.
    for (const v of ["   =1+1", "  +cmd", " \t-danger", "  @x"]) {
      expect(escapeCSV(v).startsWith('"\t')).toBe(true);
    }
  });

  test("does NOT add a tab guard to non-formula values", () => {
    for (const v of ["a,b", 'say "hi"', "plain", "1,000.00"]) {
      expect(escapeCSV(v).startsWith('"\t')).toBe(false);
    }
  });

  // ----- invariants over a large, fuzzed input space -----

  test("INVARIANT: a flagged formula value always gets the tab guard", () => {
    const rand = makePrng(12_648_430);
    for (let n = 0; n < 4000; n++) {
      const len = 1 + Math.floor(rand() * 6);
      let v = "";
      for (let k = 0; k < len; k++) {
        v += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)];
      }
      const escaped = escapeCSV(v);
      if (FORMULA_PREFIX_RE.test(v)) {
        expect(escaped.startsWith('"\t')).toBe(true);
      }
    }
  });

  test("INVARIANT: roundtrips through an RFC-4180 reader without data loss", () => {
    const rand = makePrng(4919);
    for (let n = 0; n < 4000; n++) {
      const len = Math.floor(rand() * 8);
      let v = "";
      for (let k = 0; k < len; k++) {
        v += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)];
      }
      const decoded = readCsvField(escapeCSV(v));
      // Formula values intentionally gain a leading tab (the neutralizer);
      // every other character must survive verbatim.
      const expected = FORMULA_PREFIX_RE.test(v) ? `\t${v}` : v;
      expect(decoded).toBe(expected);
    }
  });

  test("INVARIANT: the decoded cell never begins with a live formula char", () => {
    const rand = makePrng(11_259_375);
    const liveFormula = /^[=+\-@]/u;
    for (let n = 0; n < 4000; n++) {
      const len = 1 + Math.floor(rand() * 6);
      let v = "";
      for (let k = 0; k < len; k++) {
        v += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)];
      }
      const decoded = readCsvField(escapeCSV(v));
      // After neutralization a spreadsheet sees either a tab-prefixed text
      // cell or a value that simply never started with a formula char.
      if (liveFormula.test(decoded)) {
        throw new Error(
          `decoded cell starts with a live formula char: ${JSON.stringify(decoded)} (input ${JSON.stringify(v)})`,
        );
      }
    }
  });
});
