import { describe, expect, test } from "bun:test";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import { chunkDocument } from "@/api/lib/corpus-index/chunking";
import {
  readCorpusPassages,
  selectCorpusPassage,
  type CorpusPayloadSource,
} from "@/api/lib/legal-search/corpus-passage-reader";

/**
 * The fixture is asserted against `chunkDocument` rather than a hand-copied
 * string, so a returned passage is the chunker's passage by construction.
 */

const paragraph = (index: number, plainText: string): Block => ({
  id: `p${index}`,
  anchorId: `p${index}-anchor`,
  type: "paragraph",
  inlines: [],
  plainText,
});

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
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

const DECISION_ID = "decision-1";
const TEXT_KEY = "corpus/decision-1/text";
const AST_KEY = "corpus/decision-1/ast";

// Long enough that the chunker closes a passage between them, so the fixture
// has more than one anchor to address.
const ast = astOf([
  paragraph(0, `Úvodní odstavec rozhodnutí. ${"text ".repeat(120)}`),
  paragraph(1, `Odůvodnění soudu. ${"slovo ".repeat(120)}`),
  paragraph(2, `Závěrečný výrok. ${"konec ".repeat(120)}`),
]);
const fallbackText = "Nestrukturovaný text bez AST.";

const chunks = chunkDocument({ ast, fallbackText });

const source: CorpusPayloadSource = {
  readText: async (key) =>
    key === TEXT_KEY
      ? fallbackText
      : Promise.reject(new Error(`unexpected text key: ${key}`)),
  readAst: async (key) =>
    key === AST_KEY
      ? ast
      : Promise.reject(new Error(`unexpected ast key: ${key}`)),
};

const pointers = [
  { documentId: DECISION_ID, textS3Key: TEXT_KEY, astS3Key: AST_KEY },
];

describe("selectCorpusPassage", () => {
  test("returns the passage the anchor opens, as the chunker cut it", () => {
    const second = chunks.at(1);
    expect(second?.anchorId).toBeString();

    expect(
      selectCorpusPassage({
        ast,
        text: fallbackText,
        anchorId: second?.anchorId ?? "",
      }),
    ).toEqual({
      status: "found",
      seq: second?.seq ?? -1,
      text: second?.text ?? "",
    });
  });

  test("reports an anchor no passage opens", () => {
    expect(
      selectCorpusPassage({ ast, text: fallbackText, anchorId: "p9-anchor" }),
    ).toEqual({ status: "anchor_not_found" });
  });

  test("falls back to the plain text when the AST is unusable", () => {
    expect(
      selectCorpusPassage({
        ast: {},
        text: fallbackText,
        anchorId: "p0-anchor",
      }),
    ).toEqual({ status: "anchor_not_found" });
  });
});

describe("readCorpusPassages", () => {
  test("answers in request order and reads a document's payload once", async () => {
    let textReads = 0;
    let astReads = 0;
    const counting: CorpusPayloadSource = {
      readText: async (key) => {
        textReads += 1;
        return await source.readText(key);
      },
      readAst: async (key) => {
        astReads += 1;
        return await source.readAst(key);
      },
    };
    const first = chunks.at(0);
    const second = chunks.at(1);

    const results = await readCorpusPassages({
      requests: [
        { documentId: DECISION_ID, anchorId: second?.anchorId ?? "" },
        { documentId: DECISION_ID, anchorId: first?.anchorId ?? "" },
      ],
      pointers,
      source: counting,
    });

    expect(results).toEqual([
      {
        status: "found",
        documentId: DECISION_ID,
        seq: second?.seq ?? -1,
        text: second?.text ?? "",
      },
      {
        status: "found",
        documentId: DECISION_ID,
        seq: first?.seq ?? -1,
        text: first?.text ?? "",
      },
    ]);
    expect(textReads).toBe(1);
    expect(astReads).toBe(1);
  });

  test("reports a hit that carries no anchor", async () => {
    const results = await readCorpusPassages({
      requests: [{ documentId: DECISION_ID, anchorId: null }],
      pointers,
      source,
    });

    expect(results).toEqual([
      { status: "unanchored", documentId: DECISION_ID },
    ]);
  });

  test("reports a document with no payload pointer", async () => {
    const results = await readCorpusPassages({
      requests: [{ documentId: "missing", anchorId: "p0-anchor" }],
      pointers,
      source,
    });

    expect(results).toEqual([{ status: "no_payload", documentId: "missing" }]);
  });

  test("reports an anchor the document does not hold", async () => {
    const results = await readCorpusPassages({
      requests: [{ documentId: DECISION_ID, anchorId: "p9-anchor" }],
      pointers,
      source,
    });

    expect(results).toEqual([
      {
        status: "anchor_not_found",
        documentId: DECISION_ID,
        anchorId: "p9-anchor",
      },
    ]);
  });
});
