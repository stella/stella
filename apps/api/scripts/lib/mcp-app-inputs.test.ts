import { expect, test } from "bun:test";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

import { appInputProjection, appInputSchema } from "./mcp-app-inputs";

test("browser contracts omit tool prose and annotations without changing schema fields or literal values", () => {
  const literal = {
    description: "domain value",
    "x-stella-kind": "domain value",
  };
  const annotation = { kind: "date" };
  const schema = {
    type: "object",
    description: "tool description",
    "x-stella-audience": "model",
    properties: {
      description: { type: "string", description: "field description" },
      choice: { const: literal, enum: [literal], default: literal },
      date: { type: "string", [AGENT_INPUT_NORMALIZATION_KEY]: annotation },
    },
    required: ["description"],
  };
  expect(appInputSchema(schema)).toEqual({
    type: "object",
    properties: {
      description: { type: "string" },
      choice: { const: literal, enum: [literal], default: literal },
      date: { type: "string" },
    },
    required: ["description"],
  });
});

test("browser input metadata retains declared keys and array limits without schema payloads", () => {
  expect(
    appInputProjection({
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" }, maxItems: 8 },
        courts: { type: "array", items: { type: "string" }, maxItems: 24 },
        cursor: { type: "string", maxLength: 1000 },
      },
    }),
  ).toEqual({
    properties: ["queries", "courts", "cursor"],
    arrayLimits: { queries: 8, courts: 24 },
  });
});
