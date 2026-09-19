import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA } from "./template-condition-decisions";

const base = {
  path: "is_consumer",
  label: "Consumer contract",
  state: "decided",
  value: true,
} as const;

describe("TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA", () => {
  test("requires probability exactly for decision-model answers", () => {
    expect(
      v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
        ...base,
        decided_by: "decision_model",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
        ...base,
        decided_by: "decision_model",
        probability: 0.94,
      }).success,
    ).toBe(true);
  });

  test("forbids probability for user and generative answers", () => {
    for (const decidedBy of ["user", "generative_model"] as const) {
      expect(
        v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
          ...base,
          decided_by: decidedBy,
        }).success,
      ).toBe(true);
      expect(
        v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
          ...base,
          decided_by: decidedBy,
          probability: 0.94,
        }).success,
      ).toBe(false);
    }
  });

  test("accepts a named undecided reason", () => {
    expect(
      v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
        path: base.path,
        label: base.label,
        state: "undecided",
        reason: "no_decision_model",
      }).success,
    ).toBe(true);
  });
});
