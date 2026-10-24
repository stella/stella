import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { DECISION_UNDECIDED_REASON_CODES } from "@stll/api-contract/ai-decision-provider";

import {
  TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA,
  toFillConditionDecision,
  toPreviewConditionDecision,
} from "./template-condition-decisions";

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

test("generative preview projection returns only declared condition fields", () => {
  const input = {
    path: base.path,
    label: base.label,
    decision: { state: "decided", decidedBy: "generative_model", value: true },
    inputValues: { extra: "ordinary context" },
  } as const;
  expect(toPreviewConditionDecision(input)).toEqual({
    path: base.path,
    label: base.label,
    state: "decided",
    value: true,
    decided_by: "generative_model",
  });
});

describe("undecided condition wire contract", () => {
  test("rejects an unknown wire reason", () => {
    expect(
      v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
        path: base.path,
        label: base.label,
        state: "undecided",
        reason: "other",
      }).success,
    ).toBe(false);
  });

  for (const code of Object.values(DECISION_UNDECIDED_REASON_CODES)) {
    test(`accepts wire reason ${code}`, () => {
      expect(
        v.safeParse(TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA, {
          path: base.path,
          label: base.label,
          state: "undecided",
          reason: code,
        }).success,
      ).toBe(true);
    });
  }

  test("refusals survive both preview and fill without inventing a value", () => {
    const condition = {
      path: base.path,
      label: base.label,
      state: "undecided",
      reason: "refusal",
    } as const;
    expect(toFillConditionDecision(condition)).toEqual(condition);
    expect(
      toPreviewConditionDecision({
        path: base.path,
        label: base.label,
        decision: { state: "undecided", reason: "refusal" },
      }),
    ).toEqual(condition);
  });
});
