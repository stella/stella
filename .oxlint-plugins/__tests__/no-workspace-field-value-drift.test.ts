import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects display branches for all field kinds in either comparison order", async () => {
  expect(
    await lintSingleRule(
      "no-workspace-field-value-drift",
      'if (field.content.type === "text") show();\nif ("date" === field.content.type) show();\nif (field.content.type === "int") show();\nif ("single-select" === field.content.type) show();\nif (field.content.type === "multi-select") show();\nif ("clip" === field.content.type) show();',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("follows field type aliases optional reads and switch cases", async () => {
  expect(
    await lintSingleRule(
      "no-workspace-field-value-drift",
      'const type = field.content.type;\nif (type !== "date") show();\nif (fieldContent?.type == "single-select") show();\nswitch (content.type) {\ncase "text": break;\ncase "int": break;\ncase "file": break;\n}',
    ),
  ).toEqual([2, 3, 5, 6]);
});

test("accepts file and loading branches with canonical field renderers", async () => {
  expect(
    await lintSingleRule(
      "no-workspace-field-value-drift",
      'if (field.content.type === "file") route();\nif (content.type === "pending") loading();\nconst view = <FieldValue content={field.content} />;\nconst edit = <EditableField content={content} />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("distinguishes property configuration and unrelated object types from field values", async () => {
  expect(
    await lintSingleRule(
      "no-workspace-field-value-drift",
      'if (property.content.type === "date") configure();\nif (dateProperty.content.type === "single-select") configure();\nif (other.type === "text") configure();',
    ),
  ).toEqual([]);
});
