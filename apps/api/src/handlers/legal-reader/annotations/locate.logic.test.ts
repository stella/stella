import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { plainTextOf, tableCellPieceId } from "@stll/legal-ast/document-ast";
import type { Block } from "@stll/legal-ast/document-ast";
import { propertyConfig } from "@stll/property-testing";

import {
  ANNOTATION_LOCATE_ISSUE,
  locatePassages,
} from "@/api/handlers/legal-reader/annotations/locate.logic";

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: `id-${anchorId}`,
  inlines: [{ text, type: "text" }],
  plainText: text.trim(),
  type: "paragraph",
});

describe("locatePassages", () => {
  test("places a quote on the raw axis the reader anchors by", () => {
    // Leading spaces and a non-breaking space: `plainText` would trim and
    // normalize them, so offsets taken from it would land early.
    const raw = "  Soud rozhodl, že žaloba se zamítá.";
    const result = locatePassages(
      [paragraph("p-1", raw)],
      [{ anchor: "p-1", quote: "Soud rozhodl" }],
    );

    expect(result).toEqual({
      status: "located",
      spans: [
        {
          blockAnchorId: "p-1",
          startOffset: 2,
          endOffset: 14,
          quote: "Soud rozhodl",
        },
      ],
    });
  });

  test("reports every failed passage at once", () => {
    const result = locatePassages(
      [paragraph("p-1", "a b a b")],
      [
        { anchor: "[p-1]", quote: "a" },
        { anchor: "p-1", quote: "a b" },
        { anchor: "p-1", quote: "missing" },
      ],
    );

    expect(result.status).toBe("rejected");
    expect(
      result.status === "rejected"
        ? result.issues.map(({ code, passageIndex }) => [passageIndex, code])
        : [],
    ).toEqual([
      [0, ANNOTATION_LOCATE_ISSUE.anchorNotFound],
      [1, ANNOTATION_LOCATE_ISSUE.quoteAmbiguous],
      [2, ANNOTATION_LOCATE_ISSUE.quoteNotFound],
    ]);
  });

  test("anchors a table quote by the cell the reader renders it in", () => {
    const table: Block = {
      anchorId: "t-1",
      id: "table-block",
      plainText: "",
      rows: [
        [
          { inlines: [{ text: "Účastník", type: "text" }], plainText: "" },
          { inlines: [{ text: "Žalobce", type: "text" }], plainText: "" },
        ],
      ],
      type: "table",
    };

    const result = locatePassages(
      [table],
      [{ anchor: "t-1", quote: "Žalobce" }],
    );

    expect(result).toEqual({
      status: "located",
      spans: [
        {
          blockAnchorId: tableCellPieceId({
            blockId: "table-block",
            columnIndex: 1,
            rowIndex: 0,
          }),
          startOffset: 0,
          endOffset: 7,
          quote: "Žalobce",
        },
      ],
    });
  });

  test("any unique substring round-trips to its raw offsets, however its spaces are typed", () => {
    const word = fc.stringMatching(/^[a-zčřžáé§0-9]{1,8}$/u);
    const gap = fc.constantFrom(" ", " ", "\n", "  ");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(word, gap), { minLength: 2, maxLength: 12 }),
        fc.nat(),
        fc.nat(),
        (pairs, first, span) => {
          const raw = pairs.map(([w, g]) => `${w}${g}`).join("");
          const start = first % pairs.length;
          const end = Math.min(pairs.length, start + 1 + (span % 3));
          const words = pairs.slice(start, end).map(([w]) => w);
          // What a model re-types: the words joined with plain spaces.
          const quote = words.join(" ");
          const block = paragraph("p-1", raw);
          const text = plainTextOf(
            block.type === "paragraph" ? block.inlines : [],
          );
          const result = locatePassages([block], [{ anchor: "p-1", quote }]);
          if (result.status === "rejected") {
            // Only a repeated or absent needle may be refused.
            return result.issues.every(
              (issue) => issue.code === ANNOTATION_LOCATE_ISSUE.quoteAmbiguous,
            );
          }
          const [located] = result.spans;
          return (
            located !== undefined &&
            text.slice(located.startOffset, located.endOffset) ===
              located.quote &&
            located.quote.replaceAll(/\s+/gu, " ") === quote
          );
        },
      ),
      propertyConfig(),
    );
  });
});
