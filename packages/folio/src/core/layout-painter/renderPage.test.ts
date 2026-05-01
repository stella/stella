import { describe, expect, test } from "bun:test";

import type { Page, ParagraphBlock } from "../layout-engine/types";
import type { BlockLookup } from "./index";
import { computePageFingerprint } from "./renderPage";

const page: Page = {
  number: 1,
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
  size: { w: 816, h: 1056 },
  fragments: [
    {
      kind: "paragraph",
      blockId: "p1",
      x: 72,
      y: 72,
      width: 672,
      height: 24,
      fromLine: 0,
      toLine: 1,
      pmStart: 1,
      pmEnd: 12,
    },
  ],
};

function blockWithComment(commentId?: number): ParagraphBlock {
  return {
    kind: "paragraph",
    id: "p1",
    runs: [
      {
        kind: "text",
        text: "commented",
        pmStart: 1,
        pmEnd: 10,
        ...(commentId !== undefined ? { commentIds: [commentId] } : {}),
      },
    ],
  };
}

function lookup(block: ParagraphBlock): BlockLookup {
  return new Map([
    [
      "p1",
      { block, measure: { kind: "paragraph", lines: [], totalHeight: 0 } },
    ],
  ]);
}

describe("render page fingerprint", () => {
  test("changes when comment annotations change without layout geometry changing", () => {
    expect(computePageFingerprint(page, lookup(blockWithComment()))).not.toBe(
      computePageFingerprint(page, lookup(blockWithComment(123))),
    );
  });
});
