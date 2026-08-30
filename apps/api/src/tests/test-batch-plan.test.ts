import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  classifyTestBatch,
  composeTestBatches,
  dbTestBatchSize,
  hasModuleScopeProcessEnvMutation,
  isDbTest,
  TEST_BATCH_KIND,
} from "../../scripts/test-batch-plan";

const API_ROOT = path.resolve(import.meta.dir, "../..");
const PROPERTY_MARKER = ["fc", "assert"].join(".");

describe("API test batch planning", () => {
  test("keeps every DB-backed property file in its own process", async () => {
    const testPaths = [
      ...new Bun.Glob("src/**/*.test.{ts,tsx}").scanSync({
        cwd: API_ROOT,
        onlyFiles: true,
      }),
    ];
    const propertyDbTests = (
      await Promise.all(
        testPaths.map(async (testPath) => ({
          source: await Bun.file(path.join(API_ROOT, testPath)).text(),
          testPath,
        })),
      )
    )
      .filter(({ source }) => source.includes(PROPERTY_MARKER))
      .filter(
        ({ source, testPath }) =>
          classifyTestBatch({
            dbBacked: isDbTest(testPath, source),
            heavyLogic: false,
            installsModuleMock: source.includes("mock.module"),
            propertyOnly: true,
          }) === TEST_BATCH_KIND.db,
      )
      .map(({ testPath }) => testPath);

    // These are the PGlite-backed property files that motivated the guard.
    expect(propertyDbTests).toEqual(
      expect.arrayContaining([
        "src/handlers/case-law/ingestion/replay.db.test.ts",
        "src/handlers/rates/resolve.test.ts",
        "src/lib/entity-filters.differential.test.ts",
      ]),
    );
    expect(propertyDbTests.length).toBeGreaterThanOrEqual(3);

    expect(composeTestBatches(propertyDbTests, dbTestBatchSize(true))).toEqual(
      propertyDbTests.map((testPath) => [testPath]),
    );
  });

  test("property DB isolation wins for direct and helper-installed module mocks", () => {
    for (const installsModuleMock of [false, true]) {
      expect(
        classifyTestBatch({
          dbBacked: true,
          heavyLogic: false,
          installsModuleMock,
          propertyOnly: true,
        }),
      ).toBe(TEST_BATCH_KIND.db);
    }

    expect(
      classifyTestBatch({
        dbBacked: true,
        heavyLogic: false,
        installsModuleMock: true,
        propertyOnly: false,
      }),
    ).toBe(TEST_BATCH_KIND.moduleMock);
  });

  test("retains three-file DB batches for ordinary suite runs", () => {
    const dbTests = [
      "db-a.test.ts",
      "db-b.test.ts",
      "db-c.test.ts",
      "db-d.test.ts",
    ];

    expect(composeTestBatches(dbTests, dbTestBatchSize(false))).toEqual([
      ["db-a.test.ts", "db-b.test.ts", "db-c.test.ts"],
      ["db-d.test.ts"],
    ]);
  });

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

  test("isolates only module-scope process environment mutations", () => {
    const testPath = "src/example.test.ts";
    for (const source of [
      'process.env["REDIS_URL"] = "redis://127.0.0.1:1";',
      'process.env.REDIS_URL = "redis://127.0.0.1:1";',
    ]) {
      expect(hasModuleScopeProcessEnvMutation(testPath, source)).toBe(true);
    }
    for (const source of [
      'const value = process.env["REDIS_URL"];',
      'test("scoped", () => { process.env["REDIS_URL"] = "value"; });',
      '// process.env["REDIS_URL"] = "value";',
    ]) {
      expect(hasModuleScopeProcessEnvMutation(testPath, source)).toBe(false);
    }
  });
});
