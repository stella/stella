import { expect, test } from "bun:test";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

import { appInputSchema } from "./mcp-app-inputs";

test("browser contracts omit tool prose without changing schema fields or literal values", () => {
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
  const normalized = appInputSchema(schema, "normalization");
  expect(normalized).toEqual({
    type: "object",
    properties: {
      description: { type: "string" },
      choice: { const: literal, enum: [literal], default: literal },
      date: { type: "string", [AGENT_INPUT_NORMALIZATION_KEY]: annotation },
    },
    required: ["description"],
  });
  expect(appInputSchema(normalized, "validation")).toEqual({
    type: "object",
    properties: {
      description: { type: "string" },
      choice: { const: literal, enum: [literal], default: literal },
      date: { type: "string" },
    },
    required: ["description"],
  });
});
