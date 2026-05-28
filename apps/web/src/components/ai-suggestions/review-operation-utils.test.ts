import { describe, expect, test } from "bun:test";

import type { FolioAIEditOperation } from "@stll/folio";

import { isNoopReviewOperation } from "@/components/ai-suggestions/review-operation-utils";

describe("review operation no-op detection", () => {
  test("keeps style-only replaceBlock operations", () => {
    const operation = {
      blockId: "b-1",
      id: "op-1",
      styleId: "ClauseHeading1",
      text: "Existing heading",
      type: "replaceBlock",
    } satisfies FolioAIEditOperation;

    expect(
      isNoopReviewOperation(
        operation,
        new Map([
          ["b-1", { id: "b-1", styleId: "Normal", text: "Existing heading" }],
        ]),
      ),
    ).toBe(false);
  });

  test("drops replaceBlock only when text and requested style are unchanged", () => {
    const operation = {
      blockId: "b-1",
      id: "op-1",
      styleId: "ClauseHeading1",
      text: "Existing heading",
      type: "replaceBlock",
    } satisfies FolioAIEditOperation;

    expect(
      isNoopReviewOperation(
        operation,
        new Map([
          [
            "b-1",
            {
              id: "b-1",
              styleId: "ClauseHeading1",
              text: "Existing heading",
            },
          ],
        ]),
      ),
    ).toBe(true);
  });

  test("treats same-text replaceBlock without style override as a no-op", () => {
    const operation = {
      blockId: "b-1",
      id: "op-1",
      text: "Existing heading",
      type: "replaceBlock",
    } satisfies FolioAIEditOperation;

    expect(
      isNoopReviewOperation(
        operation,
        new Map([
          ["b-1", { id: "b-1", styleId: "Normal", text: "Existing heading" }],
        ]),
      ),
    ).toBe(true);
  });
});
