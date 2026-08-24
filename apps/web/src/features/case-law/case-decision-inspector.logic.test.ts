import { describe, expect, test } from "bun:test";

import {
  CASE_DECISION_VIEW,
  createCaseDecisionViewTab,
  isCaseDecisionViewPayload,
  opensCitationInInspector,
} from "@/components/inspector/case-decision-view";

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
      languageAlternateCount: 2,
      slug: "4-as-3-2008",
    }).payload;

    expect(isCaseDecisionViewPayload(payload)).toBe(true);
    expect(isCaseDecisionViewPayload({ ...payload, decisionId: "" })).toBe(
      false,
    );
  });

  test("intercepts only an unmodified primary click", () => {
    const primary = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };

    expect(opensCitationInInspector(primary)).toBe(true);
    expect(opensCitationInInspector({ ...primary, button: 1 })).toBe(false);
    expect(opensCitationInInspector({ ...primary, metaKey: true })).toBe(false);
    expect(opensCitationInInspector({ ...primary, ctrlKey: true })).toBe(false);
    expect(opensCitationInInspector({ ...primary, shiftKey: true })).toBe(
      false,
    );
  });
});
