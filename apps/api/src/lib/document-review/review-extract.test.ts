import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { collectReviewCitations } from "@/api/lib/document-review/review-extract";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";

const field = (id: string): SafeId<"field"> => toSafeId<"field">(id);

describe("review extraction citations", () => {
  test("keeps trusted PDF locators and verified DOCX anchors with ownership", () => {
    const filenames: JustificationFilenames = [
      {
        kind: "pdf-bates",
        original: "Contract.pdf",
        simplified: "contract",
        fileFieldId: field("f-pdf"),
      },
      {
        kind: "docx-folio",
        original: "Brief.docx",
        simplified: "brief",
        fileFieldId: field("f-docx"),
        blocksById: new Map([["AAAA0001", "The verified paragraph."]]),
      },
    ];
    const justification: AIJustificationOutput = [
      {
        file: "contract",
        statements: [{ text: "payment", citations: ["contract-7"] }],
      },
      {
        file: "brief",
        statements: [
          {
            text: "breach",
            citations: ["AAAA0001", "unverified prose quote"],
          },
        ],
      },
    ];

    const normalized = normalizeJustification({ justification, filenames });
    const parsed = normalized.unwrap();
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected a normalized justification");
    }

    expect(collectReviewCitations(parsed.content)).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: field("f-pdf"),
        bates: "contract-7",
        pageNumber: 7,
        statement: "payment",
      },
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "The verified paragraph.",
        statement: "breach",
      },
    ]);
  });

  test("keeps statement associations while omitting unverified hints", () => {
    expect(
      collectReviewCitations({
        version: 1,
        blocks: [
          {
            kind: "docx-folio",
            fileFieldId: field("f-docx"),
            statements: [
              {
                text: "claim one",
                citations: [
                  {
                    citationStatus: "verified",
                    blockId: "AAAA0001",
                    text: "Paragraph",
                  },
                  {
                    citationStatus: "unverified",
                    text: "model hint",
                  },
                ],
              },
              {
                text: "claim two",
                citations: [
                  {
                    citationStatus: "verified",
                    blockId: "AAAA0001",
                    text: "Paragraph",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "Paragraph",
        statement: "claim one",
      },
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "Paragraph",
        statement: "claim two",
      },
    ]);
  });
});
