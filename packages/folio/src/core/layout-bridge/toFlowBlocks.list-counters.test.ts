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
      abstractNumId: options.abstractNumId,
      startOverride: options.startOverride,
    },
  };
}

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
