import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects a raw heading in an inspector panel header", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      '<div className="flex h-12 border-b"><h2>{title}</h2></div>',
      {
        sourcePath:
          "apps/web/src/components/inspector/raw-panel-header.fixture.tsx",
      },
    ),
  ).toEqual([1]);
});

test("accepts the shared inspector header", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      "<InspectorTabHeader label={title} onClose={close} />",
      {
        sourcePath:
          "apps/web/src/components/inspector/shared-panel-header.fixture.tsx",
      },
    ),
  ).toEqual([]);
});
