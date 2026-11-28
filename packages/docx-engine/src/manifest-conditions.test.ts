import { describe, expect, test } from "bun:test";

import { manifestNamedConditions } from "./manifest-conditions";
import type { TemplateManifest } from "./types";

const manifest = (fields: TemplateManifest["fields"]): TemplateManifest => ({
  version: 1,
  fields,
});

describe("manifestNamedConditions", () => {
  test("synthesizes a boolean condition-field into a named condition", () => {
    const result = manifestNamedConditions(
      manifest([
        {
          path: "is_company",
          inputType: "boolean",
          condition: 'client_type == "company"',
          label: "Company?",
        },
      ]),
    );
    expect(result).toEqual([
      {
        name: "is_company",
        expression: 'client_type == "company"',
        label: "Company?",
      },
    ]);
  });

  test("ignores a boolean field without a condition and a non-boolean field with one", () => {
    const result = manifestNamedConditions(
      manifest([
        { path: "plain_question", inputType: "boolean" },
        // condition is only meaningful on a boolean field
        { path: "stray", inputType: "text", condition: "a == b" },
        { path: "empty_rule", inputType: "boolean", condition: "" },
      ]),
    );
    expect(result).toEqual([]);
  });
});
