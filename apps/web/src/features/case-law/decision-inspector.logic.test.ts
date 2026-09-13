import { describe, expect, test } from "bun:test";

import {
  caseDecisionTabId,
  createCaseDecisionViewTab,
} from "@/components/inspector/case-decision-view";
import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  decisionTabTarget,
  isDecisionRowActive,
} from "@/features/case-law/decision-inspector.logic";

const decision: Decision = {
  id: "decision-1",
  caseNumber: "9 A 34/2025",
  slug: "9-a-34-2025",
  ecli: null,
  court: "Městský soud v Praze",
  country: "CZE",
  language: "cs",
  languageAlternates: [],
  decisionDate: "2025-05-21",
  decisionType: "rozsudek",
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 0,
};

describe("opening a results row in the inspector", () => {
  test("the row's own facts are what the tab is built from", () => {
    expect(decisionTabTarget(decision)).toEqual({
      caseNumber: "9 A 34/2025",
      country: "CZE",
      court: "Městský soud v Praze",
      decisionId: "decision-1",
      language: "cs",
      languageAlternates: [],
      slug: "9-a-34-2025",
    });
  });

  // A cited passage opens the same tab as the row, scrolled to the anchor,
  // rather than a second tab for the same decision.
  test("a cited passage names the anchor and nothing else changes", () => {
    const target = decisionTabTarget(decision, "p-12");

    expect(target.anchorId).toBe("p-12");
    expect(createCaseDecisionViewTab(target).id).toBe(
      createCaseDecisionViewTab(decisionTabTarget(decision)).id,
    );
  });

  test("a row with no passage names no anchor", () => {
    expect("anchorId" in decisionTabTarget(decision)).toBe(false);
  });
});

describe("which row the inspector is showing", () => {
  test("the open decision's row is the active one", () => {
    expect(
      isDecisionRowActive(caseDecisionTabId("decision-1"), "decision-1"),
    ).toBe(true);
  });

  test("another decision's row is not", () => {
    expect(
      isDecisionRowActive(caseDecisionTabId("decision-2"), "decision-1"),
    ).toBe(false);
  });

  // A tab of another kind is open, or none is: no row is marked, rather than
  // the first row being marked because the ids happen to compare loosely.
  test("no tab, or a tab of another kind, marks no row", () => {
    expect(isDecisionRowActive(null, "decision-1")).toBe(false);
    expect(isDecisionRowActive("decision-1", "decision-1")).toBe(false);
  });
});
