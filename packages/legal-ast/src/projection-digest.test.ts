import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/node";

import type { Block, DocumentAst } from "./document-ast.js";
import {
  PROVISION_SPAN_PROJECTION_REVISION,
  projectionDigest,
  projectionPieces,
} from "./projection-digest.js";

const blankAst = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "d",
    webUrl: "https://court.test/d",
    printUrl: "https://court.test/d/print",
  },
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

/**
 * One document per shape the projection has to get right: every block
 * kind, nested containers, a citation (children only), a page anchor and
 * a line break (zero and one character), no-break spaces and trailing
 * whitespace (kept verbatim), a character outside the BMP (two UTF-16
 * units), and a merged table cell.
 */
const DECISION = blankAst([
  {
    id: "b0",
    anchorId: "h-0",
    type: "heading",
    level: 1,
    inlines: [{ type: "text", text: "R O Z S U D E K" }],
    plainText: "ROZSUDEK",
  },
  {
    id: "b1",
    anchorId: "p-1",
    type: "paragraph",
    inlines: [
      { type: "text", text: "Podle " },
      {
        type: "citation",
        cite: "89/2012 Sb.",
        children: [
          { type: "bold", children: [{ type: "text", text: "§ 420" }] },
          { type: "text", text: " o. z." },
        ],
      },
      { type: "page-anchor", label: "12" },
      { type: "line-break" },
      { type: "text", text: "dále  \t" },
    ],
    plainText: "",
  },
  {
    id: "b2",
    anchorId: "i-2",
    type: "image",
    src: "https://assets.test/seal.png",
    plainText: "seal",
  },
  {
    id: "b3",
    anchorId: "t-3",
    type: "table",
    rows: [
      [
        {
          inlines: [{ type: "text", text: "Sp. zn." }],
          plainText: "",
          header: true,
        },
        {
          inlines: [
            {
              type: "link",
              href: "https://court.test/x",
              children: [{ type: "text", text: "4 As 1/2020 \u{1d11e}" }],
            },
          ],
          plainText: "",
          colSpan: 2,
        },
      ],
      [{ inlines: [], plainText: "" }],
    ],
    plainText: "",
  },
]);

const FIXTURE_CORPUS: DocumentAst[] = [DECISION, blankAst([])];

/**
 * The digest of the fixture corpus at each projection revision. A change
 * to the projection moves the digest: bump
 * `PROVISION_SPAN_PROJECTION_REVISION` and add its entry here. Never edit
 * an existing entry, since stored digests were computed under it.
 */
const PINNED_CORPUS_DIGESTS = {
  1: [
    "306fde797ddba5078dbae4db6cb451258f174a70c2c522ecf03d37d91174a7bb",
    "1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9",
  ],
} as const satisfies Record<number, readonly string[]>;

describe("projectionPieces", () => {
  test("lists inline blocks and table cells in reading order, skipping images", () => {
    expect(projectionPieces(DECISION)).toEqual([
      { pieceId: "b0", text: "R O Z S U D E K" },
      { pieceId: "b1", text: "Podle § 420 o. z.\ndále  \t" },
      { pieceId: "table:b3:0:0", text: "Sp. zn." },
      { pieceId: "table:b3:0:1", text: "4 As 1/2020 \u{1d11e}" },
      { pieceId: "table:b3:1:0", text: "" },
    ]);
  });
});

describe("projectionDigest", () => {
  test("is pinned for the current projection revision", async () => {
    expect(await Promise.all(FIXTURE_CORPUS.map(projectionDigest))).toEqual([
      ...PINNED_CORPUS_DIGESTS[PROVISION_SPAN_PROJECTION_REVISION],
    ]);
  });

  test("ignores what the projection does not read", async () => {
    const relabelled: DocumentAst = {
      ...DECISION,
      metadata: { ...DECISION.metadata, caseNumber: "other" },
      blocks: DECISION.blocks.map((block) => ({
        ...block,
        anchorId: `moved-${block.anchorId}`,
        plainText: "search text is another axis",
      })),
    };
    expect(await projectionDigest(relabelled)).toBe(
      await projectionDigest(DECISION),
    );
  });

  test("separates piece boundaries from piece text", async () => {
    const paragraph = (id: string, text: string): Block => ({
      id,
      anchorId: id,
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    });
    const joined = blankAst([paragraph("a", "ab")]);
    const split = blankAst([paragraph("a", "a"), paragraph("b", "b")]);
    const renamed = blankAst([paragraph("c", "ab")]);
    const digests = new Set(
      await Promise.all([joined, split, renamed].map(projectionDigest)),
    );
    expect(digests.size).toBe(3);
  });
});

for (const text of [
  "",
  "abc",
  "Příliš žluťoučký kůň 📄 中文\u0000\ud800",
  "e\u0301",
]) {
  test(`stored projection digests retain revision, inline text and piece order: ${JSON.stringify(text)}`, async () => {
    const ast = blankAst([
      {
        id: "heading",
        anchorId: "h",
        type: "heading",
        level: 1,
        inlines: [{ type: "text", text }],
        plainText: "ignored",
      },
      {
        id: "paragraph",
        anchorId: "p",
        type: "paragraph",
        inlines: [{ type: "text", text: "e\u0301" }],
        plainText: "ignored",
      },
    ]);
    const previous = JSON.stringify([
      PROVISION_SPAN_PROJECTION_REVISION,
      [
        ["heading", text],
        ["paragraph", "e\u0301"],
      ],
    ]);
    expect(await projectionDigest(ast)).toBe(sha256Hex(previous));
    expect(await projectionDigest(blankAst([]))).toBe(
      sha256Hex(JSON.stringify([PROVISION_SPAN_PROJECTION_REVISION, []])),
    );
  });
}
