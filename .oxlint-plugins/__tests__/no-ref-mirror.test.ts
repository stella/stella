import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects render mirrors through an imported hook alias", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import { useRef as ref } from "react";\nfunction Component({ value }) {\n const saved = ref(value);\n saved.current = value;\n}',
    ),
  ).toEqual([4]);
});

test("rejects default and namespace React ref mirrors", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import React from "react";\nimport * as R from "react";\nfunction A(value) { const saved = React.useRef(value); saved.current = value; }\nfunction B(value) { const saved = R.useRef(value); saved.current = value; }',
    ),
  ).toEqual([3, 4]);
});

test("accepts callback assignments DOM refs and changed values", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import { useRef } from "react";\nfunction Component(value, other) {\n const saved = useRef(value);\n const update = () => { saved.current = value; };\n saved.current = other;\n const dom = useRef(null);\n dom.current = value;\n}',
    ),
  ).toEqual([]);
});

test("does not treat an unrelated ref factory as React", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import { useRef } from "other-library";\nfunction Component(value) { const saved = useRef(value); saved.current = value; }',
    ),
  ).toEqual([]);
});

test("accepts an explicitly configured owner", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import { useRef } from "react";\nfunction Component(value) { const saved = useRef(value); saved.current = value; }',
      {
        sourcePath: "apps/web/src/components/owner.tsx",
        ruleOptions: {
          allowedFiles: [
            {
              path: "apps/web/src/components/owner.tsx",
              reason: "Existing owner.",
            },
          ],
        },
      },
    ),
  ).toEqual([]);
});

test("does not exempt a same named ref mirror outside its configured owner", async () => {
  expect(
    await lintSingleRule(
      "no-ref-mirror",
      'import { useRef } from "react";\nfunction Component(value) { const saved = useRef(value); saved.current = value; }',
      {
        sourcePath: "apps/web/src/other/owner.tsx",
        ruleOptions: {
          allowedFiles: [
            {
              path: "apps/web/src/components/owner.tsx",
              reason: "Existing owner.",
            },
          ],
        },
      },
    ),
  ).toEqual([2]);
});
