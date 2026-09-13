import { describe, expect, test } from "bun:test";

import { matterPinSet } from "./pin-set.logic";

const page = ["d1", "d2", "d3"];

describe("what save into matter saves", () => {
  test("picked rows are what is saved", () => {
    expect(
      matterPinSet({
        pageDecisionIds: page,
        selectedDecisionIds: ["d3", "d1"],
      }),
    ).toEqual({ type: "selection", decisionIds: ["d3", "d1"] });
  });

  test("picking nothing offers the page, never the whole result set", () => {
    expect(
      matterPinSet({ pageDecisionIds: page, selectedDecisionIds: [] }),
    ).toEqual({ type: "page", decisionIds: page });
  });

  test("a row picked on another page is not saved from this one", () => {
    expect(
      matterPinSet({
        pageDecisionIds: page,
        selectedDecisionIds: ["elsewhere"],
      }),
    ).toEqual({ type: "page", decisionIds: page });
  });

  test("a row picked twice is saved once", () => {
    expect(
      matterPinSet({
        pageDecisionIds: page,
        selectedDecisionIds: ["d2", "d2"],
      }),
    ).toEqual({ type: "selection", decisionIds: ["d2"] });
  });

  test("an empty page has nothing to save", () => {
    expect(
      matterPinSet({ pageDecisionIds: [], selectedDecisionIds: ["d1"] }),
    ).toEqual({ type: "empty" });
  });

  test("nothing is ever saved that is not on the page", () => {
    for (const selected of [[], ["d1"], ["d1", "elsewhere"], ["elsewhere"]]) {
      const pinSet = matterPinSet({
        pageDecisionIds: page,
        selectedDecisionIds: selected,
      });
      if (pinSet.type === "empty") {
        continue;
      }
      for (const decisionId of pinSet.decisionIds) {
        expect(page).toContain(decisionId);
      }
    }
  });
});
