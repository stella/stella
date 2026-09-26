import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

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
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
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

const alternate = {
  caseNumber: "9 A 34/2025",
  country: "CZE",
  court: "Městský soud v Praze",
  decisionDate: "2025-05-21",
  id: "decision-1",
  language: "cs",
  slug: "9-a-34-2025",
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
    const target = decisionTabTarget(decision, { anchorId: "p-12" });

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
    expect(isDecisionRowActive(caseDecisionTabId("decision-1"), decision)).toBe(
      true,
    );
  });

  test("another decision's row is not", () => {
    expect(isDecisionRowActive(caseDecisionTabId("decision-2"), decision)).toBe(
      false,
    );
  });

  // The case-number link opens the reader's language, which is a decision of
  // its own; the row it was opened from is still the row that is open.
  test("a row is active for any of its language versions", () => {
    const multilingual: Decision = {
      ...decision,
      languageAlternates: [
        { ...alternate, id: "decision-1", language: "cs" },
        { ...alternate, id: "decision-1-en", language: "en" },
      ],
    };

    expect(
      isDecisionRowActive(caseDecisionTabId("decision-1-en"), multilingual),
    ).toBe(true);
    expect(
      isDecisionRowActive(caseDecisionTabId("decision-1-en"), decision),
    ).toBe(false);
  });

  // A tab of another kind is open, or none is: no row is marked, rather than
  // the first row being marked because the ids happen to compare loosely.
  test("no tab, or a tab of another kind, marks no row", () => {
    expect(isDecisionRowActive(null, decision)).toBe(false);
    expect(isDecisionRowActive("decision-1", decision)).toBe(false);
  });
});
