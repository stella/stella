import { describe, expect, test } from "bun:test";

import type { Position } from "@/api/lib/workflow/playbook-positions";

import {
  classifyQuestion,
  findUnchangedResends,
  isCzech,
} from "./playbook-builder-score";

const graded = (sourceId: string, issue: string, rule: string): Position => ({
  mode: "graded",
  sourceId,
  issue,
  severity: "medium",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: { rules: [{ id: `${sourceId}-rule`, text: rule }] },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: { mode: "auto" },
  enabled: true,
});

describe("playbook-builder question topics", () => {
  test.each([
    ["Do you have past executed contracts I should use?", "contracts"],
    ["Should I look for signed agreements in your matters?", "contracts"],
    ["Do you have any past executed NDAs you want me to use?", "contracts"],
    ["What contract evidence should ground the playbook?", "contracts"],
    ["What should I use as contract examples?", "contracts"],
    ["Which side are you on: buyer or seller?", "side"],
    ["Is your organization the customer/buyer under these agreements?", "side"],
    [
      "Are you reviewing these agreements as the customer buying the services?",
      "side",
    ],
    ["Which matters should I search for past NDAs?", "matters"],
    [
      "Should I look through all your matters, or only specific ones?",
      "matters",
    ],
    ["Which of your matters hold the executed agreements?", "matters"],
    ["Where should I look for the existing IT services agreements?", "matters"],
    ["Which law governs these agreements?", "law"],
    ["Which governing law should the playbook assume?", "law"],
    ["What language should the playbook be written in?", "language"],
    ["What type of contract will this playbook review?", "type"],
    ["How high should the liability cap be?", null],
  ] as const)("%s reads as %s", (question, topic) => {
    expect(classifyQuestion(question)).toBe(topic);
  });
});

describe("playbook-builder unchanged resends", () => {
  const cap = graded("a", "Liability cap", "Capped at 12 months of fees");
  const law = graded("b", "Governing law", "German law");

  test("a position named by source_id and stored unchanged is a resend", () => {
    expect(
      findUnchangedResends({
        input: { positions: [{ source_id: "a" }, { source_id: "b" }] },
        before: [cap, law],
        after: [cap, graded("b", "Governing law", "Czech law")],
      }),
    ).toEqual(["Liability cap"]);
  });

  test("a new position or a call with no positions resends nothing", () => {
    expect(
      findUnchangedResends({
        input: { positions: [{ issue: "Term" }] },
        before: [cap],
        after: [cap, graded("c", "Term", "One year")],
      }),
    ).toEqual([]);
    expect(
      findUnchangedResends({
        input: { remove_source_ids: ["a"] },
        before: [cap],
        after: [],
      }),
    ).toEqual([]);
  });
});

describe("playbook-builder language", () => {
  test("Czech diacritics read as Czech; English and German do not", () => {
    expect(isCzech("Omezení odpovědnosti")).toBe(true);
    expect(isCzech("Limitation of liability")).toBe(false);
    expect(isCzech("Haftungsbeschränkung")).toBe(false);
  });
});
