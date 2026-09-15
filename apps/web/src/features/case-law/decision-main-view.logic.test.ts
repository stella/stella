import { describe, expect, test } from "bun:test";

import { decisionMainViewAction } from "@/features/case-law/decision-main-view.logic";

describe("decisionMainViewAction", () => {
  test("offers the main view on a route that shows no decision", () => {
    expect(
      decisionMainViewAction({
        decisionId: "dec_1",
        mainDecision: undefined,
      }),
    ).toEqual({ type: "move-to-main" });
  });

  test("offers nothing while the main view is already this decision", () => {
    expect(
      decisionMainViewAction({
        decisionId: "dec_1",
        mainDecision: { id: "dec_1" },
      }),
    ).toEqual({ type: "already-main" });
  });

  test("carries the displaced decision so a swap cannot drop it", () => {
    const mainDecision = { id: "dec_2", caseNumber: "I. ÚS 281/97" };

    expect(
      decisionMainViewAction({ decisionId: "dec_1", mainDecision }),
    ).toEqual({ type: "swap-with-main", mainDecision });
  });
});
