import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { escapeCSV } from "@/api/lib/csv";

/**
 * Minimal RFC 4180 single-field reader: given the text of one CSV cell as
 * `escapeCSV` would emit it, recover the logical value a conformant parser
 * (Excel, Numbers, LibreOffice, csv-parse) would read back. Deliberately
 * independent of `escapeCSV` so the roundtrip below tests the *contract*.
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
      return out;
    }
    out += ch;
    i += 1;
  }
  return out;
};

const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/u;
const LIVE_FORMULA_RE = /^[=+\-@]/u;

// Bias the input toward the structural characters that drive escaping
// (delimiters, quotes, newlines, formula sigils, leading whitespace) while
// still covering plain text and non-ASCII.
const csvText = fc.oneof(
  fc.string(),
  fc
    .array(
      fc.constantFrom(
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
      ),
      { maxLength: 8 },
    )
    .map((parts) => parts.join("")),
);

describe("escapeCSV (properties)", () => {
  test("a flagged formula value always gets the tab guard", () => {
    fc.assert(
      fc.property(csvText, (value) => {
        if (FORMULA_PREFIX_RE.test(value)) {
          expect(escapeCSV(value).startsWith('"\t')).toBe(true);
        }
      }),
      propertyConfig({ numRuns: 1000 }),
    );
  });

  test("roundtrips through an RFC-4180 reader without data loss", () => {
    fc.assert(
      fc.property(csvText, (value) => {
        // Formula values intentionally gain a leading tab (the neutralizer);
        // every other character must survive verbatim.
        const expected = FORMULA_PREFIX_RE.test(value) ? `\t${value}` : value;
        expect(readCsvField(escapeCSV(value))).toBe(expected);
      }),
      propertyConfig({ numRuns: 1000 }),
    );
  });

  test("the decoded cell never begins with a live formula character", () => {
    fc.assert(
      fc.property(csvText, (value) => {
        expect(LIVE_FORMULA_RE.test(readCsvField(escapeCSV(value)))).toBe(
          false,
        );
      }),
      propertyConfig({ numRuns: 1000 }),
    );
  });
});
