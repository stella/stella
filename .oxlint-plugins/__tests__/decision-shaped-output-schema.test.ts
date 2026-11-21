import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("decision-shaped-output-schema", () => {
  test("reports outputs containing only decisions", async () => {
    expect(
      await lintSingleRule(
        "decision-shaped-output-schema",
        "generate({ outputSchema: v.strictObject({ applies: v.boolean(), verdict: v.picklist(VERDICTS), score: v.number() }) });",
      ),
    ).toEqual([1]);
  });
  test("resolves constants and temporal and nested decisions", async () => {
    expect(
      await lintSingleRule(
        "decision-shaped-output-schema",
        'const schema = v.object({ when: v.pipe(v.string(), v.isoDate()), values: v.array(v.optional(v.union([v.literal("a"), v.number()]))) });\nwrapper({ outputSchema: v.pipe(schema, v.description("decision")) });',
      ),
    ).toEqual([2]);
  });
  test("accepts any free text field", async () => {
    expect(
      await lintSingleRule(
        "decision-shaped-output-schema",
        "generate({ outputSchema: v.strictObject({ applies: v.boolean(), rationale: v.string() }) });",
      ),
    ).toEqual([]);
  });
  test("accepts unresolved schema composition", async () => {
    expect(
      await lintSingleRule(
        "decision-shaped-output-schema",
        "generate({ outputSchema: v.object({ ...fields, applies: v.boolean() }) });\ngenerate({ outputSchema: importedSchema });\ngenerate({ outputSchema: makeSchema() });",
      ),
    ).toEqual([]);
  });
  test("accepts explicitly generative output mode", async () => {
    expect(
      await lintSingleRule(
        "decision-shaped-output-schema",
        'generate({ outputMode: "generative", outputSchema: v.object({ applies: v.boolean() }) });',
      ),
    ).toEqual([]);
  });
});
