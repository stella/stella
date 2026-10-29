/**
 * Printed lines of a RIS transcript join into paragraphs only at a boundary
 * that is a margin's, never across a paragraph break, a content type, a short
 * line, a finished sentence or the opening of a point, and never within a
 * register section, whose entries each stand alone.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertyConfig,
  propertySeed,
} from "@stll/property-testing";

import {
  joinWrappedLines,
  MIN_WRAPPED_LINE_CHARS,
} from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import type { RisItem } from "@/api/handlers/case-law/ingestion/parsers/at-ris-markup";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

/** Apparatus sections: citing decisions and norms, one entry per line. */
const REGISTER_CONTENT_TYPES = ["entscheidungstexte", "norm"] as const;

const printedLineArb = fc.record({
  type: fc.constant("line" as const),
  contentType: fc.constantFrom(
    "text",
    "begruendung",
    ...REGISTER_CONTENT_TYPES,
  ),
  length: fc.integer({ min: 8, max: 120 }),
  ending: fc.constantFrom("", ",", "."),
  opensPoint: fc.boolean(),
});

type PrintedLine =
  typeof printedLineArb extends fc.Arbitrary<infer T> ? T : never;

type Printed = { type: "break" } | PrintedLine;

const printed: fc.Arbitrary<Printed> = fc.oneof(
  fc.constant({ type: "break" as const }),
  printedLineArb,
);

/** Line `index` as the publisher would print it: a marker, filler, an end. */
const textOf = (index: number, printedLine: PrintedLine) => {
  const head = `${printedLine.opensPoint ? "a) " : ""}L${index}_`;
  const filler = "wort ".repeat(Math.ceil(printedLine.length / 5));
  return (
    `${head} ${filler}`
      .slice(0, Math.max(printedLine.length, head.length + 1))
      .trimEnd() + printedLine.ending
  );
};

const toItem = (entry: Printed, index: number): RisItem =>
  entry.type === "break"
    ? { type: "break" }
    : {
        type: "paragraph",
        element: "absatz",
        contentType: entry.contentType,
        layout: "erltext",
        inlines: [{ type: "text", text: textOf(index, entry) }],
      };

const textOfItem = (item: RisItem): string =>
  item.type === "paragraph"
    ? item.inlines
        .map((inline) => (inline.type === "text" ? inline.text : ""))
        .join("")
    : "";

describe("RIS wrapped lines", () => {
  test("lines join only at a margin's boundary", () => {
    assertProperty(
      "at-ris-wrap-joins-only-at-margins",
      fc.property(fc.array(printed, { maxLength: 30 }), (lines) => {
        const items = lines.map(toItem);
        const joined = joinWrappedLines(items);

        const ids = (text: string): number[] =>
          [...text.matchAll(/L(\d+)_/gu)].map((match) => Number(match[1]));
        const seen = joined.flatMap((item) => ids(textOfItem(item)));
        const expected = items.flatMap((item, index) =>
          item.type === "paragraph" ? [index] : [],
        );
        // Every line survives, once, in order.
        expect(seen).toEqual(expected);

        for (const item of joined) {
          const members = ids(textOfItem(item));
          for (const [position, id] of members.entries()) {
            const next = members[position + 1];
            if (next === undefined) {
              continue;
            }
            const above = lines[id];
            const below = lines[next];
            expect(next).toBe(id + 1);
            expect(above?.type).toBe("line");
            expect(below?.type).toBe("line");
            if (above?.type === "line" && below?.type === "line") {
              expect(above.contentType).toBe(below.contentType);
              expect(REGISTER_CONTENT_TYPES).not.toContain(above.contentType);
              expect(textOf(id, above).length).toBeGreaterThanOrEqual(
                MIN_WRAPPED_LINE_CHARS,
              );
              expect(above.ending).not.toBe(".");
              expect(below.opensPoint).toBe(false);
            }
          }
        }
      }),
      config(300),
    );
  });

  // A long line joined to a short one must not carry the short one's
  // boundary: the 15-character line ends its paragraph.
  test("a short line ends the paragraph a long line opened", () => {
    const lines = [60, 15, 60].map((length, index) =>
      toItem(
        {
          type: "line",
          contentType: "text",
          length,
          ending: "",
          opensPoint: false,
        },
        index,
      ),
    );
    expect(joinWrappedLines(lines).map(textOfItem)).toEqual([
      `${textOfItem(lines[0] ?? { type: "break" })} ${textOfItem(lines[1] ?? { type: "break" })}`,
      textOfItem(lines[2] ?? { type: "break" }),
    ]);
  });
});
