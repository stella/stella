import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects a raw heading in an inspector panel header", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      "<header><h2>{title}</h2></header>",
      {
        sourcePath:
          "apps/web/src/components/inspector/raw-panel-header.fixture.tsx",
      },
    ),
  ).toEqual([1]);
});

test("rejects a raw heading in a marked inspector header slot", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      '<div data-slot="inspector-panel-header"><h2>{title}</h2></div>',
      {
        sourcePath:
          "apps/web/src/components/inspector/marked-panel-header.fixture.tsx",
      },
    ),
  ).toEqual([1]);
});

test("accepts a bordered body section heading", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      '<section className="border-b"><h2>History</h2></section>',
      {
        sourcePath:
          "apps/web/src/components/inspector/body-section.fixture.tsx",
      },
    ),
  ).toEqual([]);
});

test("accepts a document header nested inside an article", async () => {
  expect(
    await lintSingleRule(
      "inspector-header-title",
      "<article><header><h1>{subject}</h1></header></article>",
      {
        sourcePath:
          "apps/web/src/components/inspector/document-header.fixture.tsx",
      },
    ),
  ).toEqual([]);
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
