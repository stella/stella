import { describe, expect, test } from "bun:test";

import {
  type AiConditionDecider,
  resolveAiConditions,
} from "./resolve-ai-conditions";
import type { FieldMeta } from "./types";

const yesDecider: AiConditionDecider = async () => ({
  decidedBy: "generative_model",
  value: true,
});

const fields: FieldMeta[] = [
  { path: "client.name", inputType: "text" }, // plain field
  // a boolean field with an aiPrompt is decided yes/no by the model
  {
    path: "is_consumer",
    label: "Consumer contract",
    inputType: "boolean",
    aiPrompt: "Is this a consumer?",
  },
  // a non-boolean aiPrompt field is drafted as a string elsewhere, not here
  { path: "scope", inputType: "text", aiPrompt: "Draft the scope" },
];

describe("resolveAiConditions", () => {
  test("decides a boolean aiPrompt field and leaves the rest untouched", async () => {
    const { values, conditions } = await resolveAiConditions({
      values: { "client.name": "ACME" },
      fields,
      decide: yesDecider,
    });
    expect(values["is_consumer"]).toBe(true);
    expect("scope" in values).toBe(false);
    expect(conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: true,
        decidedBy: "generative_model",
      },
    ]);
  });

  test("the decision model's answer carries the probability it chose", async () => {
    const { conditions } = await resolveAiConditions({
      values: {},
      fields,
      decide: async () => ({
        decidedBy: "decision_model",
        value: false,
        probability: 0.93,
      }),
    });

    expect(conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: false,
        decidedBy: "decision_model",
        probability: 0.93,
      },
    ]);
  });

  test("a user-supplied value wins over the AI decision, and is reported as theirs", async () => {
    const { values, conditions } = await resolveAiConditions({
      values: { is_consumer: false },
      fields,
      decide: yesDecider,
    });
    expect(values["is_consumer"]).toBe(false);
    expect(conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "decided",
        value: false,
        decidedBy: "user",
      },
    ]);
  });

  test("a nested user value is read as the {% if %} block will read it", async () => {
    const { conditions } = await resolveAiConditions({
      values: { client: { is_consumer: true } },
      fields: [
        {
          path: "client.is_consumer",
          inputType: "boolean",
          aiPrompt: "Is this a consumer?",
        },
      ],
      decide: async () => ({ decidedBy: "generative_model", value: false }),
    });

    expect(conditions).toEqual([
      {
        path: "client.is_consumer",
        // Unlabelled: shown by its path, as the fill form shows it.
        label: "client.is_consumer",
        state: "decided",
        value: true,
        decidedBy: "user",
      },
    ]);
  });

  test("does not disclose source-bound values to the AI decider", async () => {
    let seenValues: Record<string, unknown> | undefined;

    const { values } = await resolveAiConditions({
      values: {
        "client.iban": "CZ6508000000192000145399",
        "client.name": "ACME",
      },
      fields: [
        {
          path: "client.iban",
          inputType: "text",
          source: { kind: "contact", field: "iban" },
        },
        {
          path: "is_consumer",
          inputType: "boolean",
          aiPrompt: "Is this a consumer?",
        },
      ],
      decide: async ({ values: visible }) => {
        seenValues = visible;
        return { decidedBy: "generative_model", value: true };
      },
    });

    expect(seenValues).toEqual({ "client.name": "ACME" });
    expect(values["client.iban"]).toBe("CZ6508000000192000145399");
    expect(values["is_consumer"]).toBe(true);
  });

  test("leaves the condition unset with no decider (block then excluded)", async () => {
    const { values, conditions } = await resolveAiConditions({
      values: {},
      fields,
      decide: undefined,
    });
    expect("is_consumer" in values).toBe(false);
    // Nothing was asked, so nothing is reported as decided or undecided.
    expect(conditions).toEqual([]);
  });

  test("a decider returning undefined leaves the condition unset and undecided", async () => {
    const { values, conditions } = await resolveAiConditions({
      values: {},
      fields,
      decide: async () => undefined,
    });
    expect("is_consumer" in values).toBe(false);
    // Reported rather than dropped: an excluded block an agent cannot see is
    // otherwise indistinguishable from a condition decided false.
    expect(conditions).toEqual([
      {
        path: "is_consumer",
        label: "Consumer contract",
        state: "undecided",
        reason: "failed",
      },
    ]);
  });
});
