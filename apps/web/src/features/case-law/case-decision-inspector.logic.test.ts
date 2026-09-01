import { describe, expect, test } from "bun:test";

import {
  CASE_DECISION_VIEW,
  createCaseDecisionViewTab,
  isCaseDecisionGenericTab,
  isCaseDecisionViewPayload,
  isPlainPrimaryClick,
  navigateToCaseDecisionMain,
  opensCitationInInspector,
} from "@/components/inspector/case-decision-view";
import type { InspectorTab } from "@/components/inspector/inspector-store-types";

describe("case decision inspector", () => {
  test("derives one stable tab and canonical route payload", () => {
    expect(
      createCaseDecisionViewTab({
        caseNumber: "4 As 3/2008",
        country: "CZ",
        court: "Nejvyšší správní soud",
        decisionId: "d4f1bfe6-f7e4-42a2-9d4f-fd121ea90b34",
        slug: "4-as-3-2008",
      }),
    ).toEqual({
      type: CASE_DECISION_VIEW,
      id: "case-law-decision:d4f1bfe6-f7e4-42a2-9d4f-fd121ea90b34",
      label: "4 As 3/2008",
      payload: {
        caseNumber: "4 As 3/2008",
        country: "cz",
        court: "nejvyssi-spravni-soud",
        decisionId: "d4f1bfe6-f7e4-42a2-9d4f-fd121ea90b34",
        slug: "4-as-3-2008",
      },
    });
  });

  test("validates synchronized payloads", () => {
    const payload = createCaseDecisionViewTab({
      caseNumber: "4 As 3/2008",
      country: "CZ",
      court: "NSS",
      decisionId: "decision-id",
      language: "cs",
      languageAlternates: [{ language: "cs" }, { language: "en" }],
      slug: "4-as-3-2008",
    }).payload;

    expect(isCaseDecisionViewPayload(payload)).toBe(true);
    expect(isCaseDecisionViewPayload({ ...payload, decisionId: "" })).toBe(
      false,
    );
  });

  test("narrows only stored generic tabs carrying a decision payload", () => {
    const decisionTab: InspectorTab = {
      type: "view",
      viewType: CASE_DECISION_VIEW,
      id: "case-law-decision:decision-id",
      label: "4 As 3/2008",
      payload: createCaseDecisionViewTab({
        caseNumber: "4 As 3/2008",
        country: "CZ",
        court: "NSS",
        decisionId: "decision-id",
        slug: "4-as-3-2008",
      }).payload,
    };

    expect(isCaseDecisionGenericTab(decisionTab)).toBe(true);
    expect(
      isCaseDecisionGenericTab({
        ...decisionTab,
        viewType: "statute-provision",
      }),
    ).toBe(false);
    expect(
      isCaseDecisionGenericTab({ ...decisionTab, payload: { broken: true } }),
    ).toBe(false);
  });

  test("maps a tab payload onto the matching main-view route", () => {
    const calls: unknown[] = [];
    const navigate: Parameters<typeof navigateToCaseDecisionMain>[0] = async (
      options,
    ) => {
      calls.push(options);
    };

    const base = createCaseDecisionViewTab({
      caseNumber: "4 As 3/2008",
      country: "CZ",
      court: "Nejvyšší správní soud",
      decisionId: "decision-id",
      slug: "4-as-3-2008",
    }).payload;
    void navigateToCaseDecisionMain(navigate, base);
    void navigateToCaseDecisionMain(
      navigate,
      createCaseDecisionViewTab({
        caseNumber: "C-400/99",
        country: "EU",
        court: "Court of Justice",
        decisionId: "eu-decision-id",
        language: "es",
        languageAlternates: [{ language: "es" }, { language: "en" }],
        slug: "c-400-99-f472865427c41152",
      }).payload,
    );

    expect(calls).toEqual([
      {
        to: "/law/$country/cases/$court/$slug",
        params: {
          country: "cz",
          court: "nejvyssi-spravni-soud",
          slug: "4-as-3-2008",
        },
      },
      {
        to: "/law/$country/cases/$court/$language/$slug",
        params: {
          country: "eu",
          court: "court-of-justice",
          language: "es",
          slug: "c-400-99-f472865427c41152",
        },
      },
    ]);
  });

  test("intercepts only an unmodified primary click", () => {
    const primary = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };

    expect(isPlainPrimaryClick(primary)).toBe(true);
    expect(isPlainPrimaryClick({ ...primary, altKey: true })).toBe(false);
    expect(opensCitationInInspector(primary, true)).toBe(true);
    expect(opensCitationInInspector(primary, false)).toBe(false);
    expect(opensCitationInInspector({ ...primary, button: 1 }, true)).toBe(
      false,
    );
    expect(opensCitationInInspector({ ...primary, metaKey: true }, true)).toBe(
      false,
    );
    expect(opensCitationInInspector({ ...primary, ctrlKey: true }, true)).toBe(
      false,
    );
    expect(opensCitationInInspector({ ...primary, shiftKey: true }, true)).toBe(
      false,
    );
  });
});
