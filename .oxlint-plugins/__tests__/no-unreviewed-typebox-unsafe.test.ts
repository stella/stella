import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports named namespace and destructured unsafe aliases", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type as T, Unsafe as raw } from "@sinclair/typebox";\nimport * as schema from "typebox";\nconst { Type: { Unsafe: nested } } = schema;\nT.Unsafe({});\nraw({});\nnested({});',
      {},
    ),
  ).toEqual([4, 5, 6]);
});

test("reports Elysia unsafe builders", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { t as schema } from "elysia";\nschema.Unsafe({});',
      {},
    ),
  ).toEqual([2]);
});

test("allows ordinary builders and lexical shadows", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type } from "@sinclair/typebox";\nType.String();\nfunction local(Type) { return Type.Unsafe({}); }',
      {},
    ),
  ).toEqual([]);
});

test("allows an exact reviewed top level adapter", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type } from "@sinclair/typebox";\nexport const adapter = Type.Unsafe({});',
      {
        sourcePath: "apps/api/src/lib/schema-adapter.ts",
        ruleOptions: {
          approvedAdapters: [
            {
              binding: "adapter",
              path: "apps/api/src/lib/schema-adapter.ts",
              reason: "The runtime shape is validated",
            },
          ],
        },
      },
    ),
  ).toEqual([]);
});

test("rejects a same named adapter outside its reviewed owner", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type } from "@sinclair/typebox";\nexport const adapter = Type.Unsafe({});',
      {
        sourcePath: "apps/api/src/other/schema-adapter.ts",
        ruleOptions: {
          approvedAdapters: [
            {
              binding: "adapter",
              path: "apps/api/src/lib/schema-adapter.ts",
              reason: "The runtime shape is validated",
            },
          ],
        },
      },
    ),
  ).toEqual([2]);
});

test("rejects nested adapters and reports unused reviews", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type } from "@sinclair/typebox";\nfunction wrap() { const adapter = Type.Unsafe({}); }',
      {
        sourcePath: "apps/api/src/lib/schema-adapter.ts",
        ruleOptions: {
          approvedAdapters: [
            {
              binding: "adapter",
              path: "apps/api/src/lib/schema-adapter.ts",
              reason: "The runtime shape is validated",
            },
          ],
        },
      },
    ),
  ).toEqual([1, 2]);
});

test("reports stale reviews even without an unsafe call", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      "export const adapter = 1;",
      {
        sourcePath: "apps/api/src/lib/schema-adapter.ts",
        ruleOptions: {
          approvedAdapters: [
            {
              binding: "adapter",
              path: "apps/api/src/lib/schema-adapter.ts",
              reason: "The runtime shape is validated",
            },
          ],
        },
      },
    ),
  ).toEqual([1]);
});

test("consumes each reviewed adapter approval only once", async () => {
  expect(
    await lintSingleRule(
      "no-unreviewed-typebox-unsafe",
      'import { Type } from "@sinclair/typebox";\nconst adapter = [Type.Unsafe({}), Type.Unsafe({})];',
      {
        sourcePath: "apps/api/src/lib/schema-adapter.ts",
        ruleOptions: {
          approvedAdapters: [
            {
              binding: "adapter",
              path: "apps/api/src/lib/schema-adapter.ts",
              reason: "The runtime shape is validated",
            },
          ],
        },
      },
    ),
  ).toEqual([2]);
});
