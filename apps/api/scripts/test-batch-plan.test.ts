import { expect, test } from "bun:test";

import { isDbTest } from "./test-batch-plan";

test("detects database runtime imports without matching inert source text", () => {
  const testPath = "src/example.test.ts";
  for (const source of [
    'import { rootDb } from "@/api/db/root";',
    'import { type RootDb, rootDb } from "@/api/db/root";',
    'import rootDb from "@/api/db/root";',
    'import * as pglite from "@electric-sql/pglite";',
    'import "@/api/db/root";',
  ]) {
    expect(isDbTest(testPath, source)).toBe(true);
  }

  for (const source of [
    'import type { RootDb } from "@/api/db/root";',
    'import { type RootDb } from "@/api/db/root";',
    'import type * as pglite from "@electric-sql/pglite";',
    'const example = "@/api/db/root";',
    '// import { rootDb } from "@/api/db/root";',
    'test("mentions pglite", () => {});',
  ]) {
    expect(isDbTest(testPath, source)).toBe(false);
  }

  expect(isDbTest("src/example.db.test.ts", "")).toBe(true);
});
