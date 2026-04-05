import { describe, expect, test } from "bun:test";

import type { DocumentAst, Inline } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { sanitizeResult } from "@/api/handlers/case-law/ingestion/pipeline";

const concatInlineText = (inlines: Inline[]): string => {
  let out = "";
  for (const node of inlines) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "bold":
      case "italic":
      case "link":
        out += concatInlineText(node.children);
        break;
      case "line-break":
        out += "\n";
        break;
      default:
        break;
    }
  }
  return out;
};

const baseResult = (documentAst: DocumentAst): IngestionResult => ({
  caseNumber: "X/1/2026",
  court: "Test Court",
  country: "SK",
  language: "sk",
  metadata: {},
  rawHash: "hash",
  documentAst,
});

const astMetadata = {
  caseNumber: "X/1/2026",
  court: "Test Court",
  ecli: "ECLI:SK:TEST:2026:1.1",
  decisionDate: "2026-01-01",
  decisionType: "uznesenie",
  keywords: [],
  statutes: [],
};

describe("sanitizeResult — documentAst text fields", () => {
  // plainText fields feed the DB full-text search index, so we
  // collapse spaced-letter emphasis ("r o z h o d o l" → "rozhodol")
  // there. Inline text is the court's verbatim rendering, and must
  // not be touched by the sanitizer so the reader shows the document
  // exactly as the court set it.
  test("plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "h-holding",
          type: "heading",
          level: 2,
          role: "section-heading",
          inlines: [
            {
              type: "bold",
              children: [{ type: "text", text: "r o z h o d o l :" }],
            },
          ],
          plainText: "r o z h o d o l :",
        },
        {
          id: "b2",
          anchorId: "p1",
          type: "paragraph",
          inlines: [
            {
              type: "text",
              text: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
            },
          ],
          plainText: "Podľa § 193 ods.1 z a m i e t a obžalobu.",
        },
        {
          id: "b3",
          anchorId: "p2",
          type: "paragraph",
          inlines: [{ type: "text", text: "Normálny text bez medzier." }],
          plainText: "Normálny text bez medzier.",
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }

    const [holding, holdingPara, plainPara] = sanitized.documentAst.blocks;
    if (
      holding?.type !== "heading" ||
      holdingPara?.type !== "paragraph" ||
      plainPara?.type !== "paragraph"
    ) {
      throw new Error("unexpected block types after sanitize");
    }

    // plainText is collapsed in-place.
    expect(holding.plainText).toBe("rozhodol:");
    expect(holdingPara.plainText).toBe("Podľa § 193 ods.1 zamieta obžalobu.");
    // Normal text without spaced-letter runs round-trips unchanged.
    expect(plainPara.plainText).toBe("Normálny text bez medzier.");

    // Inline text is NEVER mutated — the reader must render the
    // court's exact formatting.
    expect(concatInlineText(holding.inlines)).toBe("r o z h o d o l :");
    expect(concatInlineText(holdingPara.inlines)).toBe(
      "Podľa § 193 ods.1 z a m i e t a obžalobu.",
    );
    expect(concatInlineText(plainPara.inlines)).toBe(
      "Normálny text bez medzier.",
    );
  });

  test("table cell plainText is collapsed, inline text stays verbatim", () => {
    const ast: DocumentAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "x",
        webUrl: "",
        printUrl: "",
      },
      metadata: astMetadata,
      blocks: [
        {
          id: "b1",
          anchorId: "t1",
          type: "table",
          plainText: "z a m i e t a\nplain cell",
          rows: [
            [
              {
                inlines: [{ type: "text", text: "z a m i e t a" }],
                plainText: "z a m i e t a",
              },
              {
                inlines: [{ type: "text", text: "plain cell" }],
                plainText: "plain cell",
              },
            ],
          ],
        },
      ],
    };

    const sanitized = sanitizeResult(baseResult(ast));
    if (!("blocks" in sanitized.documentAst)) {
      throw new Error("sanitized documentAst should be a DocumentAst");
    }
    const table = sanitized.documentAst.blocks[0];
    if (table?.type !== "table") {
      throw new Error("expected table");
    }
    const [firstRow] = table.rows;
    const [spacedCell, plainCell] = firstRow ?? [];
    if (!spacedCell || !plainCell) {
      throw new Error("expected two cells in first row");
    }

    expect(spacedCell.plainText).toBe("zamieta");
    expect(plainCell.plainText).toBe("plain cell");

    expect(concatInlineText(spacedCell.inlines)).toBe("z a m i e t a");
    expect(concatInlineText(plainCell.inlines)).toBe("plain cell");
  });
});
