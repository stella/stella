import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad managed facades", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { db } from "@/api/db";\nimport { capture } from "@/api/lib/analytics";',
    ),
  ).toEqual([1, 2]);
});

test("rejects dynamic imports of unowned managed modules", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'const errors = import("@/lib/errors/shared");',
    ),
  ).toEqual([1]);
});

test("rejects leaf reexports that recreate a facade", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'export { capture } from "@/api/lib/analytics/capture";\nexport * from "@/api/db/schema";',
    ),
  ).toEqual([1, 2]);
});

test("accepts owning leaves imported directly", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { db } from "@/api/db/root";\nimport { capture } from "@/api/lib/analytics/capture";\nimport { APIError } from "@/lib/errors/api";',
    ),
  ).toEqual([]);
});

test("accepts unrelated module namespaces", async () => {
  expect(
    await lintSingleRule(
      "no-facade-imports",
      'import { capture } from "@/api/lib/analytics-extra";\nexport { format } from "./format";',
    ),
  ).toEqual([]);
});
