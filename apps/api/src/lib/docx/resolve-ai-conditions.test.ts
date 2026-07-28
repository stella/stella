import { describe, expect, test } from "bun:test";

import {
  type AiConditionDecider,
  resolveAiConditions,
} from "./resolve-ai-conditions";
import type { FieldMeta } from "./types";

const yesDecider: AiConditionDecider = async () => true;

const fields: FieldMeta[] = [
  { path: "client.name", inputType: "text" }, // plain field
  // a boolean field with an aiPrompt is decided yes/no by the model
  {
    path: "is_consumer",
    inputType: "boolean",
    aiPrompt: "Is this a consumer?",
  },
  // a non-boolean aiPrompt field is drafted as a string elsewhere, not here
  { path: "scope", inputType: "text", aiPrompt: "Draft the scope" },
];

describe("resolveAiConditions", () => {
  test("decides a boolean aiPrompt field and leaves the rest untouched", async () => {
    const result = await resolveAiConditions({
      values: { "client.name": "ACME" },
      fields,
      decide: yesDecider,
    });
    expect(result["is_consumer"]).toBe(true);
    expect("scope" in result).toBe(false);
  });

  test("a user-supplied value wins over the AI decision", async () => {
    const result = await resolveAiConditions({
      values: { is_consumer: false },
      fields,
      decide: yesDecider,
    });
    expect(result["is_consumer"]).toBe(false);
  });

  test("leaves the condition unset with no decider (block then excluded)", async () => {
    const result = await resolveAiConditions({
      values: {},
      fields,
      decide: undefined,
    });
    expect("is_consumer" in result).toBe(false);
  });

  test("a decider returning undefined leaves the condition unset", async () => {
    const result = await resolveAiConditions({
      values: {},
      fields,
      decide: async () => undefined,
    });
    expect("is_consumer" in result).toBe(false);
  });
});
