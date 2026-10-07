import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects loose schema conversion nested in either structured output kind", async () => {
  expect(
    await lintSingleRule(
      "ai-output-strict-schema",
      [
        "Output.object({",
        "  schema: { nested: valibotSchema(schema) },",
        "});",
        "Output.array({",
        "  element: valibotSchema(schema),",
        "});",
      ].join("\n"),
    ),
  ).toEqual([2, 5]);
});

test("allows strict conversion and ordinary schemas outside the output boundary", async () => {
  expect(
    await lintSingleRule(
      "ai-output-strict-schema",
      [
        "Output.object({ schema: strictOutputSchema(schema) });",
        "Output.array({ element: strictOutputSchema(schema) });",
        "const ordinary = valibotSchema(schema);",
        "Other.object({ schema: valibotSchema(schema) });",
      ].join("\n"),
    ),
  ).toEqual([]);
});
