import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import {
  sharePassages,
  verifiedPassageTexts,
  withGradingSource,
} from "@/api/lib/workflow/cited-passages";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";

describe("sharePassages", () => {
  test("every passage is sent once and every item can name its own", () => {
    assertProperty(
      "every passage is sent once and every item can name its own",
      fc.property(
        fc.array(fc.array(fc.string({ minLength: 1 }).filter(hasVisibleText))),
        (passagesByItem) => {
          const { unique, labeled } = sharePassages(
            passagesByItem.map((passages) => ({ passages })),
          );
          expect(new Set(unique).size).toBe(unique.length);
          for (const {
            item: { passages },
            labels,
          } of labeled) {
            const recovered = labels.map(
              (label) => unique[Number(label.slice(1)) - 1],
            );
            expect(new Set(recovered)).toEqual(new Set(passages));
          }
        },
      ),
    );
  });

  test("a blank block is not a passage", () => {
    const item = { passages: ["", "  ", "Clause."] };
    expect(sharePassages([item])).toEqual({
      unique: ["Clause."],
      labeled: [{ item, labels: ["P1"] }],
    });
  });
});

describe("verifiedPassageTexts", () => {
  const fileFieldId = toSafeId<"field">("file_field");

  test("a citation to an unknown block never becomes a passage", () => {
    const normalized = normalizeJustification({
      justification: [
        {
          file: "F0",
          statements: [
            {
              text: "Payment term.",
              citations: [
                "b1",
                "b-unknown",
                "A quote that is in no block of the file.",
              ],
            },
          ],
        },
      ],
      filenames: [
        {
          kind: "docx-folio",
          original: "file",
          simplified: "F0",
          fileFieldId,
          blocksById: new Map([["b1", "Payable within 30 days."]]),
        },
      ],
    });
    const content = Result.unwrap(normalized)?.content;
    expect(
      content &&
        verifiedPassageTexts(withGradingSource(content, "clause-summary")),
    ).toEqual(["Payable within 30 days."]);
  });

  test("a page citation has no text to pass on", () => {
    expect(
      verifiedPassageTexts({
        version: 1,
        gradeFrom: "cited-passages",
        blocks: [
          {
            kind: "pdf-bates",
            fileFieldId,
            statements: [
              {
                text: "Payment term.",
                citations: [{ bates: "F0-0002", pageNumber: 2 }],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

const hasVisibleText = (text: string): boolean => text.trim().length > 0;
