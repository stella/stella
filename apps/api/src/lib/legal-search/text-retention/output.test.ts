import { describe, expect, test } from "bun:test";

import type { DocumentAst, Inline } from "@stll/legal-ast/document-ast";

import { compareRetention } from "./compare";
import { readOutputText } from "./output";
import { TEXT_ORACLE_LIMITS } from "./types";

const astOf = (blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: { system: "fixture", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

describe("rendered AST retention text", () => {
  test("walks tables, apparatus, note labels and images without trusting cached plainText", () => {
    const documentAst = astOf([
      {
        type: "paragraph",
        id: "1",
        anchorId: "1",
        role: "apparatus",
        inlines: [{ type: "text", text: "visible" }],
        plainText: "wrong cache",
      },
      {
        type: "table",
        id: "2",
        anchorId: "2",
        rows: [
          [
            {
              inlines: [{ type: "text", text: "cell" }],
              plainText: "wrong cell cache",
            },
          ],
        ],
        plainText: "wrong table cache",
        note: { type: "footnote", label: "3", noteId: "n" },
      },
      {
        type: "paragraph",
        id: "3",
        anchorId: "3",
        note: { type: "footnote", label: "3", noteId: "n" },
        inlines: [{ type: "text", text: "continued note" }],
        plainText: "wrong",
      },
      {
        type: "image",
        id: "4",
        anchorId: "4",
        src: "https://example.org/image",
        alt: "formula",
        plainText: "wrong",
      },
    ]);
    const output = readOutputText({ type: "ast", documentAst }).unwrap().text;
    expect(output).not.toContain("wrong");
    expect(output.match(/3/gu)).toHaveLength(1);
    expect(
      compareRetention({
        source: "visible 3 cell continued note formula",
        output,
      }).unwrap(),
    ).toMatchObject({ defect: null });
  });

  test("annotation and arbitrary inline segmentation preserve text", () => {
    for (let split = 0; split <= "αβγ123".length; split += 1) {
      const documentAst = astOf([
        {
          type: "heading",
          level: 1,
          id: "a",
          anchorId: "a",
          plainText: "stale",
          inlines: [
            { type: "text", text: "αβγ123".slice(0, split) },
            {
              type: "citation",
              cite: "metadata citation",
              children: [
                {
                  type: "bold",
                  children: [{ type: "text", text: "αβγ123".slice(split) }],
                },
              ],
            },
            { type: "page-anchor", label: "metadata page" },
          ],
        },
      ]);
      expect(
        readOutputText({ type: "ast", documentAst }).unwrap().text.trim(),
      ).toBe("αβγ123");
    }
  });

  test("fulltext-only output is explicitly inspected", () => {
    expect(
      readOutputText({ type: "fulltext", fulltext: "only source" }).unwrap()
        .text,
    ).toBe("only source");
  });

  test("deep inline nesting fails rather than omitting content", () => {
    let inline: Inline = { type: "text", text: "leaf" };
    for (let depth = 0; depth < TEXT_ORACLE_LIMITS.depth + 2; depth += 1) {
      inline = { type: "bold", children: [inline] };
    }
    const documentAst = astOf([
      {
        type: "paragraph",
        id: "a",
        anchorId: "a",
        plainText: "leaf",
        inlines: [inline],
      },
    ]);
    expect(
      readOutputText({ type: "ast", documentAst }).unwrapErr().reason,
    ).toBe("resource_limit");
  });
});
