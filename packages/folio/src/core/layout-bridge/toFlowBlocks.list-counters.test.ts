import { describe, expect, test } from "bun:test";

import { toProseDoc } from "../prosemirror/conversion/toProseDoc";
import type { Document, Paragraph } from "../types/document";
import { toFlowBlocks } from "./toFlowBlocks";

function listParagraph(options: {
  numId: number;
  ilvl?: number;
  text: string;
  abstractNumId?: number;
  startOverride?: number;
  marker?: string;
  pPrMark?: Paragraph["pPrMark"];
}): Paragraph {
  const ilvl = options.ilvl ?? 0;
  return {
    type: "paragraph",
    formatting: { numPr: { numId: options.numId, ilvl } },
    content: [{ type: "run", content: [{ type: "text", text: options.text }] }],
    listRendering: {
      marker: options.marker ?? "(%1)",
      level: ilvl,
      numId: options.numId,
      isBullet: false,
      numFmt: "decimal",
      levelNumFmts: ["decimal"],
      ...(options.abstractNumId !== undefined
        ? { abstractNumId: options.abstractNumId }
        : {}),
      ...(options.startOverride !== undefined
        ? { startOverride: options.startOverride }
        : {}),
    },
    ...(options.pPrMark ? { pPrMark: options.pPrMark } : {}),
  };
}

const INS_MARK = {
  kind: "ins",
  info: { id: 1, author: "A", date: "2026-01-01T00:00:00Z" },
} as const;
const DEL_MARK = {
  kind: "del",
  info: { id: 2, author: "A", date: "2026-01-01T00:00:00Z" },
} as const;

function documentWith(content: Paragraph[]): Document {
  return { package: { document: { content } } };
}

function markersOf(blocks: ReturnType<typeof toFlowBlocks>): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "paragraph" && block.attrs?.listMarker) {
      out.push(block.attrs.listMarker);
    }
  }
  return out;
}

describe("toFlowBlocks counter sharing by abstractNumId", () => {
  test("top-level numIds with the same abstractNum keep independent counters", () => {
    const doc = documentWith([
      listParagraph({ numId: 1, abstractNumId: 4, text: "a" }),
      listParagraph({ numId: 2, abstractNumId: 4, text: "b" }),
      listParagraph({ numId: 1, abstractNumId: 4, text: "c" }),
    ]);

    expect(markersOf(toFlowBlocks(toProseDoc(doc), {}))).toEqual([
      "(1)",
      "(1)",
      "(2)",
    ]);
  });

  test("startOverride resets only the concrete numId on first encounter", () => {
    const doc = documentWith([
      listParagraph({ numId: 1, abstractNumId: 4, text: "a" }),
      listParagraph({ numId: 1, abstractNumId: 4, text: "b" }),
      listParagraph({
        numId: 2,
        abstractNumId: 4,
        startOverride: 1,
        text: "c",
      }),
      listParagraph({ numId: 1, abstractNumId: 4, text: "d" }),
      listParagraph({
        numId: 2,
        abstractNumId: 4,
        startOverride: 1,
        text: "e",
      }),
    ]);

    expect(markersOf(toFlowBlocks(toProseDoc(doc), {}))).toEqual([
      "(1)",
      "(2)",
      "(1)",
      "(3)",
      "(2)",
    ]);
  });

  test("tracked insertions and deletions number on independent streams", () => {
    // An inserted list (a, b) followed by a deleted list (c, d, e) sharing one
    // numId must restart for the deletion: Word numbers inserted vs deleted runs
    // as if they never coexist. Regression for the a,b,c,d,e bug.
    const doc = documentWith([
      listParagraph({ numId: 6, text: "a", pPrMark: INS_MARK }),
      listParagraph({ numId: 6, text: "b", pPrMark: INS_MARK }),
      listParagraph({ numId: 6, text: "c", pPrMark: DEL_MARK }),
      listParagraph({ numId: 6, text: "d", pPrMark: DEL_MARK }),
      listParagraph({ numId: 6, text: "e", pPrMark: DEL_MARK }),
    ]);

    expect(markersOf(toFlowBlocks(toProseDoc(doc), {}))).toEqual([
      "(1)",
      "(2)",
      "(1)",
      "(2)",
      "(3)",
    ]);
  });

  test("normal items advance both streams so a deleted sibling continues from survivors", () => {
    // final doc: a=1, c=2 ; original doc: a=1, (deleted)=2, c=3.
    // The surviving normal items show final numbering; the deletion keeps its
    // original number (2), which requires the preceding normal item to have
    // advanced the original stream too.
    const doc = documentWith([
      listParagraph({ numId: 6, text: "a" }),
      listParagraph({ numId: 6, text: "b", pPrMark: DEL_MARK }),
      listParagraph({ numId: 6, text: "c" }),
    ]);

    expect(markersOf(toFlowBlocks(toProseDoc(doc), {}))).toEqual([
      "(1)",
      "(2)",
      "(2)",
    ]);
  });

  test("numIds without an abstractNumId stay independent", () => {
    const doc = documentWith([
      listParagraph({ numId: 1, text: "a" }),
      listParagraph({ numId: 2, text: "b" }),
    ]);

    expect(markersOf(toFlowBlocks(toProseDoc(doc), {}))).toEqual([
      "(1)",
      "(1)",
    ]);
  });
});
