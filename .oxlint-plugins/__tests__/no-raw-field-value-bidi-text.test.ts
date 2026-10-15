import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw automatic direction on intrinsic and custom components", async () => {
  expect(
    await lintSingleRule(
      "no-raw-field-value-bidi-text",
      'const a = <span dir="auto">value</span>;\nconst b = <div dir={"auto"} />;\nconst c = <Label dir="auto" />;',
      { plugin: "no-workspace-field-value-drift", sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts bidi-isolating text owners", async () => {
  expect(
    await lintSingleRule(
      "no-raw-field-value-bidi-text",
      'const a = <BidiText dir="auto">value</BidiText>;\nconst b = <UserText dir={"auto"}>value</UserText>;',
      { plugin: "no-workspace-field-value-drift", sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("leaves explicit directions dynamic directions and absent directions alone", async () => {
  expect(
    await lintSingleRule(
      "no-raw-field-value-bidi-text",
      'const a = <span dir="rtl" />;\nconst b = <span dir="ltr" />;\nconst c = <span dir={direction} />;\nconst d = <span />;',
      { plugin: "no-workspace-field-value-drift", sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
