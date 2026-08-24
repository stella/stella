import { describe, expect, test } from "bun:test";

import {
  getDocumentAstMetadata,
  hasUsableAst,
  isDocumentAst,
  parseDocumentAst,
  parseUsableDocumentAst,
} from "./document-ast";
import type { DocumentAst } from "./document-ast";

const documentAst = {
  version: 1,
  source: {
    system: "cz-nsoud",
    documentId: "30-cdo-161-2024",
    webUrl: "https://example.test/decision",
    printUrl: "https://example.test/decision/print",
  },
  metadata: {
    caseNumber: "30 Cdo 161/2024",
    ecli: "ECLI:CZ:NS:2024:30.CDO.161.2024.1",
    court: "Nejvyšší soud",
    decisionDate: "2024-03-15",
    decisionType: "rozsudek",
    keywords: ["procesní právo"],
    statutes: ["99/1963 Sb."],
  },
  blocks: [
    {
      id: "h1",
      anchorId: "h-1",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "Rozsudek" }],
      plainText: "Rozsudek",
    },
    {
      id: "p1",
      anchorId: "p-1",
      type: "paragraph",
      role: "intro",
      inlines: [{ type: "text", text: "Soud rozhodl..." }],
      plainText: "Soud rozhodl...",
    },
  ],
} satisfies DocumentAst;

describe("isDocumentAst", () => {
  test("accepts a well-formed v1 document AST", () => {
    expect(isDocumentAst(documentAst)).toBe(true);
  });

  test("rejects an AST missing required source and metadata", () => {
    expect(isDocumentAst({ version: 1, blocks: [] })).toBe(false);
  });

  test("accepts extra unknown top-level fields (guard does not reject extras)", () => {
    expect(isDocumentAst({ ...documentAst, somethingElse: true })).toBe(true);
  });

  test("rejects an AST whose blocks contain malformed elements", () => {
    expect(
      isDocumentAst({ version: 1, blocks: [{ junk: true }, 42, null] }),
    ).toBe(false);
  });

  test("rejects malformed nested inline content", () => {
    expect(
      isDocumentAst({
        ...documentAst,
        blocks: [
          {
            ...documentAst.blocks[0],
            inlines: [{ type: "bold", children: [{ junk: true }] }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("rejects non-object metadata", () => {
    expect(
      isDocumentAst({ version: 1, blocks: [], metadata: "not-an-object" }),
    ).toBe(false);
  });

  test("rejects a missing version", () => {
    expect(isDocumentAst({ blocks: [] })).toBe(false);
  });

  test("rejects a wrong-typed version", () => {
    expect(isDocumentAst({ version: "1", blocks: [] })).toBe(false);
    expect(isDocumentAst({ version: 2, blocks: [] })).toBe(false);
    expect(isDocumentAst({ version: 1.5, blocks: [] })).toBe(false);
    expect(isDocumentAst({ version: true, blocks: [] })).toBe(false);
  });

  test("rejects missing blocks", () => {
    expect(isDocumentAst({ version: 1 })).toBe(false);
  });

  test("rejects non-array blocks", () => {
    expect(isDocumentAst({ version: 1, blocks: {} })).toBe(false);
    expect(isDocumentAst({ version: 1, blocks: "[]" })).toBe(false);
    expect(isDocumentAst({ version: 1, blocks: null })).toBe(false);
  });

  test("rejects non-object inputs", () => {
    expect(isDocumentAst(null)).toBe(false);
    expect(isDocumentAst(undefined)).toBe(false);
    expect(isDocumentAst("string")).toBe(false);
    expect(isDocumentAst(1)).toBe(false);
    expect(isDocumentAst(true)).toBe(false);
  });

  test("rejects an array (arrays lack a numeric version of 1)", () => {
    expect(isDocumentAst([])).toBe(false);
    expect(isDocumentAst([{ version: 1, blocks: [] }])).toBe(false);
  });

  test("invariant: never accepts when version is anything but the literal 1", () => {
    const blocks: unknown[] = [];
    const nonOneVersions: unknown[] = [
      0,
      -1,
      2,
      "1",
      1.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      undefined,
      false,
      true,
      {},
      [1],
    ];
    for (const version of nonOneVersions) {
      expect(isDocumentAst({ version, blocks })).toBe(false);
    }
  });

  test("invariant: rejects every primitive input", () => {
    const primitives: unknown[] = [
      "",
      "x",
      0,
      1,
      -3.14,
      true,
      false,
      null,
      undefined,
      Symbol("s"),
      123n,
    ];
    for (const primitive of primitives) {
      expect(isDocumentAst(primitive)).toBe(false);
    }
  });
});

describe("parseDocumentAst", () => {
  test("parses a JSON string into an AST", () => {
    expect(parseDocumentAst(JSON.stringify(documentAst))).toEqual(documentAst);
  });

  test("passes through an already-parsed AST object", () => {
    expect(parseDocumentAst(documentAst)).toEqual(documentAst);
  });

  test("normalizes sparse historical v1 ASTs", () => {
    expect(parseDocumentAst({ version: 1, blocks: [] })).toEqual({
      version: 1,
      source: { system: "", documentId: "", webUrl: "", printUrl: "" },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [],
    });
  });

  test("returns null for null and undefined", () => {
    expect(parseDocumentAst(null)).toBe(null);
    expect(parseDocumentAst(undefined)).toBe(null);
  });

  test("returns null for invalid JSON strings", () => {
    expect(parseDocumentAst("{not json")).toBe(null);
    expect(parseDocumentAst("")).toBe(null);
  });

  test("returns null for a JSON string that parses but is not an AST", () => {
    expect(parseDocumentAst(JSON.stringify({ version: 2, blocks: [] }))).toBe(
      null,
    );
    expect(parseDocumentAst("[]")).toBe(null);
    expect(parseDocumentAst("42")).toBe(null);
    expect(parseDocumentAst('"a string"')).toBe(null);
  });

  test("returns null for non-AST objects", () => {
    expect(parseDocumentAst({ version: 1 })).toBe(null);
    expect(parseDocumentAst({ blocks: [] })).toBe(null);
  });

  test("invariant: parsing a stringified AST round-trips through the guard", () => {
    const parsed = parseDocumentAst(JSON.stringify(documentAst));
    expect(parsed).toEqual(documentAst);
    expect(parsed === null ? false : isDocumentAst(parsed)).toBe(true);
  });

  test("round-trips additive footnote metadata on a v1 paragraph", () => {
    const withFootnote = {
      ...documentAst,
      blocks: [
        ...documentAst.blocks,
        {
          id: "fn1",
          anchorId: "_ftn1",
          type: "paragraph",
          note: { type: "footnote", label: "1" },
          inlines: [{ type: "text", text: "[1] Note" }],
          plainText: "[1] Note",
        },
      ],
    } as const satisfies DocumentAst;

    expect(parseDocumentAst(JSON.stringify(withFootnote))).toEqual(
      withFootnote,
    );
  });
});

describe("getDocumentAstMetadata", () => {
  test("returns the metadata of a valid AST", () => {
    expect(getDocumentAstMetadata(documentAst)).toEqual(documentAst.metadata);
  });

  test("returns metadata when parsing from a JSON string", () => {
    expect(getDocumentAstMetadata(JSON.stringify(documentAst))).toEqual(
      documentAst.metadata,
    );
  });

  test("returns null when the input is not a valid AST", () => {
    expect(getDocumentAstMetadata(null)).toBe(null);
    expect(getDocumentAstMetadata("nope")).toBe(null);
    expect(getDocumentAstMetadata({ version: 2 })).toBe(null);
  });

  test("returns null when an AST has no metadata field", () => {
    expect(getDocumentAstMetadata({ version: 1, blocks: [] })).toBe(null);
  });
});

describe("hasUsableAst", () => {
  test("accepts an AST with at least one block", () => {
    expect(hasUsableAst(documentAst)).toBe(true);
  });

  test("rejects an AST with empty blocks", () => {
    expect(hasUsableAst({ version: 1, blocks: [] })).toBe(false);
  });

  test("rejects anything that is not a valid AST", () => {
    expect(hasUsableAst(null)).toBe(false);
    expect(hasUsableAst({ version: 2, blocks: [{ a: 1 }] })).toBe(false);
    expect(hasUsableAst("string")).toBe(false);
  });
});

describe("parseUsableDocumentAst", () => {
  test("normalizes persisted ASTs and requires at least one valid block", () => {
    const sparseAst = { version: 1, blocks: documentAst.blocks };
    const parsed = parseUsableDocumentAst(sparseAst);

    expect(parsed?.blocks).toEqual(documentAst.blocks);
    expect(parsed === null ? false : isDocumentAst(parsed)).toBe(true);
    expect(parseUsableDocumentAst({ version: 1, blocks: [] })).toBe(null);
    expect(
      parseUsableDocumentAst({ version: 1, blocks: [{ junk: true }] }),
    ).toBe(null);
  });
});
