import { describe, expect, test } from "bun:test";

import { mainLegalDocument } from "./main-legal-document.logic";

describe("the legal document the main view is showing", () => {
  test("carries the decision's own id and case number", () => {
    expect(
      mainLegalDocument({
        decision: { caseNumber: "Mfv.10127/2026/4", id: "decision-1" },
        statute: undefined,
      }),
    ).toEqual({
      type: "decision",
      caseNumber: "Mfv.10127/2026/4",
      decisionId: "decision-1",
    });
  });

  test("carries the consolidation's own id and the act's title", () => {
    expect(
      mainLegalDocument({
        decision: undefined,
        statute: { id: "statute-1", title: "Občanský zákoník" },
      }),
    ).toEqual({
      type: "statute",
      documentId: "statute-1",
      title: "Občanský zákoník",
    });
  });

  test("is nothing on a route that shows no corpus document", () => {
    expect(
      mainLegalDocument({ decision: undefined, statute: undefined }),
    ).toBeUndefined();
  });
});
