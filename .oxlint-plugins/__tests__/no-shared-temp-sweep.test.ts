import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects deleting temporary-root entries found by enumeration", async () => {
  expect(
    await lintSingleRule(
      "no-shared-temp-sweep",
      'import { readdirSync, rmSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nfor (const name of readdirSync(tmpdir())) { rmSync(path.join(tmpdir(), name), { recursive: true }); }',
    ),
  ).toEqual([4]);
});

test("accepts removing the exact directory returned by mkdtemp", async () => {
  expect(
    await lintSingleRule(
      "no-shared-temp-sweep",
      'import { mkdtempSync, rmSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst owned = mkdtempSync(path.join(tmpdir(), "owned-"));\nrmSync(owned, { recursive: true });',
    ),
  ).toEqual([]);
});
