import { describe, expect, test } from "bun:test";

import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { generatedViewsCases } from "./generated-views-cases";
import { scoreGeneratedViews } from "./generated-views-score";

const selections = () =>
  generatedViewsCases.map(({ id }) => ({
    caseId: id,
    harness: "synthetic-scorer-test",
    answer: "",
    toolCalls: [{ name: VISUAL_PREVIEW_TOOL_NAME }],
  }));

describe("local generated-view selection scoring", () => {
  test("accepts recorded tool choices for every fixture", () => {
    const scores = scoreGeneratedViews(selections());
    expect(scores.map(({ caseId }) => caseId).toSorted()).toEqual(
      generatedViewsCases.map(({ id }) => id).toSorted(),
    );
    expect(
      scores.every(
        ({ selectionPass, presentationPass }) =>
          selectionPass && presentationPass,
      ),
    ).toBe(true);
  });

  test("rejects raw HTML answers without a visual tool call for every intent", () => {
    const scores = scoreGeneratedViews(
      selections().map((result) => ({
        ...result,
        answer: "```html\n<h1>Analysis</h1>\n```",
        toolCalls: [],
      })),
    );
    expect(
      scores.every(
        ({ selectionPass, presentationPass }) =>
          !selectionPass && !presentationPass,
      ),
    ).toBe(true);
  });

  test("requires exactly one result for every fixture", () => {
    const results = selections();
    expect(() => scoreGeneratedViews(results.slice(1))).toThrow(
      "Results must cover each generated-view case exactly once",
    );
    expect(() => scoreGeneratedViews([...results, ...results])).toThrow(
      "Results must cover each generated-view case exactly once",
    );
  });
});
