import { describe, expect, test } from "bun:test";

import {
  APPARATUS_ROLES,
  getDocumentAstMetadata,
  hasUsableAst,
  HEADING_ROLES,
  isApparatusRole,
  isDocumentAst,
  omitDerivablePlainText,
  PARAGRAPH_ROLES,
  parseDocumentAst,
  parseUsableDocumentAst,
  persistedAstDegradations,
  withProjectedPlainText,
} from "./document-ast";
import type {
  Block,
  DocumentAst,
  ParagraphNote,
  ParagraphRole,
} from "./document-ast";

/** The role of a block that carries one, for assertions over mixed lists. */
const roleOf = (block: Block | undefined): string | undefined =>
  block === undefined || block.type === "image" ? undefined : block.role;

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

describe("withProjectedPlainText", () => {
  const tableAst = (cellText: string): DocumentAst => ({
    ...documentAst,
    blocks: [
      {
        id: "t1",
        anchorId: "t-1",
        type: "table",
        role: "metadata-table",
        rows: [
          [
            { inlines: [{ type: "text", text: cellText }], plainText: "stale" },
            { inlines: [{ type: "text", text: "NS" }], plainText: "stale" },
          ],
          [{ inlines: [{ type: "text", text: "Rok" }], plainText: "stale" }],
        ],
        plainText: "stale table text",
      },
    ],
  });

  test("collapses a letter-spaced table cell into the table's own text", () => {
    const [block] = withProjectedPlainText(tableAst("z a m i e t a")).blocks;

    if (block?.type !== "table") {
      throw new Error("expected a table block");
    }
    // The corpus index reads the table-level field for a table, so a
    // letter-spaced cell has to be findable by its collapsed form here,
    // not only inside the cell.
    expect(block.rows[0]?.[0]?.plainText).toBe("zamieta");
    expect(block.plainText).toBe("zamieta\tNS\nRok");
  });

  test("derives the table text from the projected cells, not the parser's", () => {
    const [block] = withProjectedPlainText(tableAst("Soud")).blocks;

    if (block?.type !== "table") {
      throw new Error("expected a table block");
    }
    expect(block.plainText).toBe("Soud\tNS\nRok");
  });

  test("keeps the table's own text on the wire, being unrebuildable", () => {
    const projected = withProjectedPlainText(tableAst("z a m i e t a"));
    const wireAst = omitDerivablePlainText(projected);
    const [wire] = wireAst.blocks;

    if (wire?.type !== "table") {
      throw new Error("expected a table block");
    }
    expect(wire.plainText).toBe("zamieta\tNS\nRok");
    expect(wire.rows[0]?.[0]).not.toHaveProperty("plainText");
    expect(parseDocumentAst(JSON.stringify(wireAst))).toEqual(projected);
  });
});

describe("persisted roles outside the declared sets", () => {
  const withRoles = (
    heading: string | undefined,
    paragraph: string | undefined,
  ) => ({
    ...documentAst,
    blocks: [
      { ...documentAst.blocks[0], role: heading },
      { ...documentAst.blocks[1], role: paragraph },
    ],
  });

  test("the canonical guard rejects a role a writer does not declare", () => {
    expect(isDocumentAst(withRoles("decision-title", "not-a-role"))).toBe(
      false,
    );
    expect(isDocumentAst(withRoles("not-a-role", "intro"))).toBe(false);
  });

  test("the persisted reader keeps the document and degrades the role", () => {
    const parsed = parseDocumentAst(withRoles("not-a-role", "not-a-role"));
    expect(parsed).not.toBeNull();
    expect(parsed?.blocks.map(roleOf)).toEqual([undefined, "unknown"]);
  });

  test("the persisted reader leaves declared roles untouched", () => {
    const parsed = parseDocumentAst(withRoles("section-heading", "holding"));
    expect(parsed?.blocks.map(roleOf)).toEqual(["section-heading", "holding"]);
  });

  test("reports what it degraded, by block", () => {
    expect(
      persistedAstDegradations(withRoles("section-heading", "verdict")),
    ).toEqual([
      { kind: "block-role", blockId: "p1", type: "paragraph", role: "verdict" },
    ]);
    expect(persistedAstDegradations(withRoles("title", "intro"))).toEqual([
      { kind: "block-role", blockId: "h1", type: "heading", role: "title" },
    ]);
    expect(
      persistedAstDegradations(withRoles("decision-title", undefined)),
    ).toEqual([]);
  });

  test("reports nothing for a value that is not an AST", () => {
    expect(persistedAstDegradations(null)).toEqual([]);
    expect(persistedAstDegradations({ blocks: "none" })).toEqual([]);
  });

  test("invariant: every declared role survives the persisted reader unchanged", () => {
    for (const role of PARAGRAPH_ROLES) {
      const stored = withRoles(undefined, role);
      expect(roleOf(parseDocumentAst(stored)?.blocks[1])).toBe(role);
      expect(persistedAstDegradations(stored)).toEqual([]);
    }
    for (const role of HEADING_ROLES) {
      const stored = withRoles(role, undefined);
      expect(roleOf(parseDocumentAst(stored)?.blocks[0])).toBe(role);
      expect(persistedAstDegradations(stored)).toEqual([]);
    }
  });
});

describe("apparatus roles", () => {
  /**
   * The fold is a decision about publisher-authored matter, so the set is
   * declared once and every reader asks this guard. A role added to
   * `APPARATUS_ROLES` must be a declared paragraph role, which the
   * `satisfies` on the array already forces; this pins the runtime half.
   */
  test("names exactly the declared publisher-authored roles", () => {
    for (const role of APPARATUS_ROLES) {
      expect(PARAGRAPH_ROLES).toContain(role);
      expect(isApparatusRole(role)).toBe(true);
    }
  });

  test("the bench and the court's own words are not folded away", () => {
    const notFolded = [
      "panel",
      "intro",
      "holding",
      "quote",
      "unknown",
    ] as const satisfies readonly ParagraphRole[];
    for (const role of notFolded) {
      expect(isApparatusRole(role)).toBe(false);
    }
    expect(isApparatusRole(undefined)).toBe(false);
    expect(isApparatusRole("not-a-role")).toBe(false);
  });
});

describe("image blocks", () => {
  const imageAst = (image: Record<string, unknown>) => ({
    ...documentAst,
    blocks: [{ id: "i1", anchorId: "i-1", type: "image", ...image }],
  });

  const seal = {
    src: "https://assets.test/seal.png",
    alt: "Court seal",
    width: 120,
    height: 120,
    plainText: "Court seal",
  };

  test("accepts an addressed, sized figure", () => {
    expect(isDocumentAst(imageAst(seal))).toBe(true);
  });

  test("rejects bytes carried inline instead of an address", () => {
    expect(
      isDocumentAst(
        imageAst({ ...seal, src: "data:image/png;base64,iVBORw0KGgo=" }),
      ),
    ).toBe(false);
    expect(
      isDocumentAst(imageAst({ ...seal, src: "http://assets.test/s.png" })),
    ).toBe(false);
    expect(isDocumentAst(imageAst({ ...seal, src: "seal.png" }))).toBe(false);
  });

  test("rejects a non-integer or non-positive size", () => {
    expect(isDocumentAst(imageAst({ ...seal, width: 0 }))).toBe(false);
    expect(isDocumentAst(imageAst({ ...seal, height: 1.5 }))).toBe(false);
    expect(isDocumentAst(imageAst({ ...seal, width: -4 }))).toBe(false);
  });

  test("derives plainText from the alt text, and rebuilds it on the wire", () => {
    const parsed = parseDocumentAst(imageAst(seal));
    if (parsed === null) {
      throw new Error("expected a parsed AST");
    }
    const projected = withProjectedPlainText(parsed);
    expect(projected.blocks.at(0)?.plainText).toBe("Court seal");

    const wire = omitDerivablePlainText(projected);
    expect(wire.blocks.at(0)).not.toHaveProperty("plainText");
    expect(parseDocumentAst(JSON.stringify(wire))).toEqual(projected);
  });

  test("a figure with no alt text carries no text at all", () => {
    const { alt: _alt, ...unlabelled } = seal;
    const parsed = parseDocumentAst(
      imageAst({ ...unlabelled, plainText: "stale" }),
    );
    if (parsed === null) {
      throw new Error("expected a parsed AST");
    }
    expect(withProjectedPlainText(parsed).blocks.at(0)?.plainText).toBe("");
  });
});

describe("table cell spans and header cells", () => {
  const cellAst = (cell: Record<string, unknown>) => ({
    ...documentAst,
    blocks: [
      {
        id: "t1",
        anchorId: "t-1",
        type: "table",
        rows: [[{ inlines: [{ type: "text", text: "Rok" }], ...cell }]],
        plainText: "Rok",
      },
    ],
  });

  test("accepts a spanning header cell", () => {
    expect(
      isDocumentAst(
        cellAst({ plainText: "Rok", colSpan: 2, rowSpan: 3, header: true }),
      ),
    ).toBe(true);
  });

  test("rejects a span of one: the default is written by omitting it", () => {
    expect(isDocumentAst(cellAst({ plainText: "Rok", colSpan: 1 }))).toBe(
      false,
    );
    expect(isDocumentAst(cellAst({ plainText: "Rok", rowSpan: 1 }))).toBe(
      false,
    );
    expect(isDocumentAst(cellAst({ plainText: "Rok", colSpan: 2.5 }))).toBe(
      false,
    );
  });

  test("keeps spans and header flags across the wire round trip", () => {
    const parsed = parseDocumentAst(
      cellAst({ colSpan: 2, rowSpan: 2, header: true }),
    );
    if (parsed === null) {
      throw new Error("expected a parsed AST");
    }
    const projected = withProjectedPlainText(parsed);
    expect(
      parseDocumentAst(JSON.stringify(omitDerivablePlainText(projected))),
    ).toEqual(projected);

    const [block] = projected.blocks;
    if (block?.type !== "table") {
      throw new Error("expected a table block");
    }
    expect(block.rows[0]?.[0]).toEqual({
      inlines: [{ type: "text", text: "Rok" }],
      plainText: "Rok",
      colSpan: 2,
      rowSpan: 2,
      header: true,
    });
  });
});

describe("multi-paragraph footnotes", () => {
  /** `undefined` stands for a body paragraph between notes. */
  const noteAst = (
    notes: readonly (ParagraphNote | undefined)[],
  ): DocumentAst => ({
    ...documentAst,
    blocks: notes.map((note, index) => ({
      id: `fn${String(index)}`,
      anchorId: `_ftn${String(index)}`,
      type: "paragraph",
      ...(note === undefined ? {} : { note }),
      inlines: [{ type: "text", text: "Note" }],
      plainText: "Note",
    })),
  });

  test("parts of one note share a noteId and repeat the label", () => {
    const stored = noteAst([
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "1", noteId: "n1" },
    ]);
    expect(isDocumentAst(stored)).toBe(true);
    expect(parseDocumentAst(JSON.stringify(stored))).toEqual(stored);
  });

  test("a note complete by itself carries no noteId", () => {
    const stored = noteAst([{ type: "footnote", label: "1" }]);
    expect(isDocumentAst(stored)).toBe(true);
    expect(parseDocumentAst(JSON.stringify(stored))).toEqual(stored);
  });

  test("a writer cannot put two labels under one adjacent noteId; a reader still serves it", () => {
    const stored = noteAst([
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "2", noteId: "n1" },
    ]);
    expect(isDocumentAst(stored)).toBe(false);
    expect(parseDocumentAst(JSON.stringify(stored))).toEqual(stored);
  });

  test("the same noteId in two separate runs is two notes, each free to be labelled", () => {
    const stored = noteAst([
      { type: "footnote", label: "1", noteId: "n1" },
      undefined,
      { type: "footnote", label: "2", noteId: "n1" },
    ]);
    expect(isDocumentAst(stored)).toBe(true);
  });
});

describe("persisted kinds outside the declared sets", () => {
  const astWith = (blocks: readonly unknown[]) => ({
    ...documentAst,
    blocks,
  });

  /** No `plainText`, so each assertion below reads the text the persisted
   * reader rebuilt from the inlines it managed to keep. */
  const paragraphWith = (inlines: readonly unknown[]) => ({
    id: "p1",
    anchorId: "p-1",
    type: "paragraph",
    inlines,
  });

  test("an unknown inline container keeps the text its children carried", () => {
    const parsed = parseDocumentAst(
      astWith([
        paragraphWith([
          { type: "text", text: "before " },
          {
            type: "small-caps",
            children: [
              { type: "text", text: "THE " },
              { type: "bold", children: [{ type: "text", text: "COURT" }] },
            ],
          },
          { type: "text", text: " after" },
        ]),
      ]),
    );
    expect(parsed?.blocks.at(0)?.plainText).toBe("before THE COURT after");
  });

  test("an unknown inline leaf keeps its own text", () => {
    const parsed = parseDocumentAst(
      astWith([paragraphWith([{ type: "marginal-note", text: "note" }])]),
    );
    expect(parsed?.blocks.at(0)?.plainText).toBe("note");
  });

  test("an unknown inline carrying nothing is dropped", () => {
    const parsed = parseDocumentAst(
      astWith([
        paragraphWith([
          { type: "text", text: "kept" },
          { type: "ornament", weight: 3 },
        ]),
      ]),
    );
    expect(parsed?.blocks.at(0)?.plainText).toBe("kept");
  });

  test("an unknown inline nested inside a declared one still degrades", () => {
    const parsed = parseDocumentAst(
      astWith([
        paragraphWith([
          { type: "bold", children: [{ type: "small-caps", text: "COURT" }] },
        ]),
      ]),
    );
    expect(parsed?.blocks.at(0)?.plainText).toBe("COURT");
  });

  test("a malformed declared inline is still a parse failure", () => {
    expect(parseDocumentAst(astWith([paragraphWith([{ type: "bold" }])]))).toBe(
      null,
    );
  });

  test("an unknown block is dropped, the rest of the document served", () => {
    const parsed = parseDocumentAst(
      astWith([
        { id: "x1", anchorId: "x-1", type: "sidebar", body: "aside" },
        documentAst.blocks[1],
      ]),
    );
    expect(parsed?.blocks.map((block) => block.id)).toEqual(["p1"]);
  });

  test("the canonical guard rejects both, so a writer cannot persist them", () => {
    expect(
      isDocumentAst(
        astWith([
          {
            ...paragraphWith([{ type: "small-caps", children: [] }]),
            plainText: "",
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isDocumentAst(
        astWith([
          { id: "x1", anchorId: "x-1", type: "sidebar", plainText: "" },
        ]),
      ),
    ).toBe(false);
  });

  test("reports each degradation by kind", () => {
    expect(
      persistedAstDegradations(
        astWith([
          { id: "x1", type: "sidebar" },
          paragraphWith([
            { type: "small-caps", children: [] },
            { type: "small-caps", children: [] },
            { type: "ornament" },
          ]),
          {
            id: "t1",
            type: "table",
            rows: [[{ inlines: [{ type: "ruby", text: "r" }] }]],
          },
        ]),
      ),
    ).toEqual([
      { kind: "block-type", blockId: "x1", type: "sidebar" },
      { kind: "inline-type", blockId: "p1", type: "small-caps" },
      { kind: "inline-type", blockId: "p1", type: "ornament" },
      { kind: "inline-type", blockId: "t1", type: "ruby" },
    ]);
  });
});
