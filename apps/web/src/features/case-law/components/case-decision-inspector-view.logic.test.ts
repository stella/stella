import { describe, expect, test } from "bun:test";

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { readerTargetCitation } from "@/components/legal-reader/annotations/reader-annotation-target";
import { decisionInspectorAnnotationTarget } from "@/features/case-law/components/case-decision-inspector-view.logic";

describe("the inspector decision citation", () => {
  test("uses one loaded decision for its court, style, date, and type", () => {
    const payload = createCaseDecisionViewTab({
      caseNumber: "56 Co 24/2026",
      country: "CZE",
      court: "Krajský soud v Plzni",
      decisionId: "decision-id",
      slug: "56-co-24-2026-71",
    }).payload;
    expect(payload.court).toBe("Krajský soud v Plzni");
    expect(payload.route.court).toBe("krajsky-soud-v-plzni");

    const target = decisionInspectorAnnotationTarget({
      ast: null,
      decision: {
        caseNumber: "56 Co 24/2026",
        country: "CZE",
        court: "Krajský soud v Plzni",
        decisionDate: "2026-03-18",
        decisionType: "rozsudek",
        ecli: null,
      },
      decisionId: "decision-id",
      payload,
    });

    expect(readerTargetCitation({ locator: null, target })).toBe(
      "rozsudek Krajského soudu v Plzni ze dne 18. 3. 2026, sp. zn. 56 Co 24/2026",
    );
  });

  test("does not invent unavailable decision metadata before the read", () => {
    const payload = createCaseDecisionViewTab({
      caseNumber: "56 Co 24/2026",
      country: "CZE",
      court: "Krajský soud v Plzni",
      decisionId: "decision-id",
      slug: "56-co-24-2026-71",
    }).payload;

    const target = decisionInspectorAnnotationTarget({
      ast: null,
      decision: undefined,
      decisionId: "decision-id",
      payload,
    });

    expect({
      decisionDate: target.decisionDate,
      decisionType: target.decisionType,
      ecli: target.ecli,
      name: target.name,
    }).toEqual({
      decisionDate: null,
      decisionType: null,
      ecli: null,
      name: null,
    });
  });
});
