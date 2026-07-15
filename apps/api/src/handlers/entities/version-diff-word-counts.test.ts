import { describe, expect, test } from "bun:test";

import type { FolioVersionDiff } from "@stll/folio-core/server";

import { countVersionDiffWords } from "./version-diff-word-counts";

const mainHandle = { story: { type: "main" }, blockId: "block-1" } as const;

describe("version diff counts", () => {
  test("counts text changes across added, deleted, and modified blocks", () => {
    const diff = {
      changes: [
        {
          type: "added",
          blockId: "added",
          kind: "paragraph",
          text: "Příliš žluťoučký kůň 2026",
          revisedHandle: mainHandle,
        },
        {
          type: "deleted",
          blockId: "deleted",
          kind: "paragraph",
          text: "two removed",
          baseHandle: mainHandle,
        },
        {
          type: "modified",
          blockId: "modified",
          kind: "paragraph",
          segments: [
            { type: "equal", text: "kept " },
            { type: "del", text: "old phrase" },
            { type: "ins", text: "new phrase here" },
          ],
          baseHandle: mainHandle,
          revisedHandle: mainHandle,
        },
      ],
    } as const satisfies Pick<FolioVersionDiff, "changes">;

    expect(countVersionDiffWords(diff)).toEqual({
      wordsAdded: 7,
      wordsRemoved: 4,
    });
  });

  test("ignores moves and formatting-only changes", () => {
    const diff = {
      changes: [
        {
          type: "movedFrom",
          blockId: "moved",
          kind: "paragraph",
          text: "same text",
          moveGroupId: 1,
          baseHandle: mainHandle,
        },
        {
          type: "movedTo",
          blockId: "moved",
          kind: "paragraph",
          text: "same text",
          moveGroupId: 1,
          revisedHandle: mainHandle,
        },
        {
          type: "formatChanged",
          blockId: "formatted",
          kind: "paragraph",
          text: "same text",
          changedProperties: ["bold"],
          baseHandle: mainHandle,
          revisedHandle: mainHandle,
        },
      ],
    } as const satisfies Pick<FolioVersionDiff, "changes">;

    expect(countVersionDiffWords(diff)).toEqual({
      wordsAdded: 0,
      wordsRemoved: 0,
    });
  });
});
