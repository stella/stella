import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listApiTestPaths,
  planApiTestBatches,
} from "../../scripts/api-test-plan";
import {
  classifyTestBatch,
  composeTestBatches,
  dbTestBatchSize,
  hasModuleScopeProcessEnvMutation,
  isDbTest,
  SOLO_TEST_PATHS,
  splitSoloTests,
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
            heavyDb: false,
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
          heavyDb: false,
          installsModuleMock,
          propertyOnly: true,
        }),
      ).toBe(TEST_BATCH_KIND.db);
    }

    expect(
      classifyTestBatch({
        dbBacked: true,
        heavyLogic: false,
        heavyDb: false,
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

  test.each([false, true])(
    "heavy DB files run alone with their ceiling (property mode: %s)",
    async (propertyOnly) => {
      const apiRoot = mkdtempSync(path.join(tmpdir(), "api-heavy-db-"));
      const ordinaryPaths = ["src/a.db.test.ts", "src/b.db.test.ts"];
      const heavyPaths = ["src/c.db.test.ts", "src/d.db.test.ts"];
      try {
        mkdirSync(path.join(apiRoot, "src"));
        await Promise.all(
          [...ordinaryPaths, ...heavyPaths].map((testPath) =>
            Bun.write(
              path.join(apiRoot, testPath),
              [
                heavyPaths.includes(testPath) ? "// @api-test-heavy-db" : "",
                'assertProperty("fixture", property);',
              ].join("\n"),
            ),
          ),
        );
        const groups = await planApiTestBatches({
          apiRoot,
          propertyOnly,
          testPaths: [...ordinaryPaths, ...heavyPaths],
        });
        expect(
          groups.find(({ kind }) => kind === TEST_BATCH_KIND.heavyDb),
        ).toEqual({
          isolate: false,
          kind: TEST_BATCH_KIND.heavyDb,
          maxPeakRssMb: 3072,
          testBatches: heavyPaths.map((testPath) => [testPath]),
        });
        expect(groups.find(({ kind }) => kind === TEST_BATCH_KIND.db)).toEqual({
          isolate: false,
          kind: TEST_BATCH_KIND.db,
          maxPeakRssMb: 2560,
          testBatches: propertyOnly
            ? ordinaryPaths.map((testPath) => [testPath])
            : [ordinaryPaths],
        });
      } finally {
        rmSync(apiRoot, { recursive: true, force: true });
      }
    },
  );

  test("heavy DB classification excludes logic markers and wins over module mocks", () => {
    for (const propertyOnly of [false, true]) {
      for (const installsModuleMock of [false, true]) {
        const options = {
          dbBacked: true,
          heavyDb: true,
          heavyLogic: false,
          installsModuleMock,
          propertyOnly,
        };
        expect(classifyTestBatch(options)).toBe(TEST_BATCH_KIND.heavyDb);
        expect(() =>
          classifyTestBatch({ ...options, heavyLogic: true }),
        ).toThrow(
          "Heavy DB tests must be DB-backed and cannot also be heavy logic",
        );
        expect(() =>
          classifyTestBatch({ ...options, dbBacked: false }),
        ).toThrow(
          "Heavy DB tests must be DB-backed and cannot also be heavy logic",
        );
      }
    }
  });

  test("full-size sanctions corpora declare singleton heavy DB batches", async () => {
    const testPaths = [
      "src/lib/lists/sanctions/refresh-event-loop.db.test.ts",
      "src/handlers/sanctions/public-routes.db.test.ts",
      "src/lib/lists/sanctions/monitoring-drain.db.test.ts",
    ];
    const groups = await planApiTestBatches({
      apiRoot: API_ROOT,
      propertyOnly: false,
      testPaths,
    });
    expect(
      groups.find(({ kind }) => kind === TEST_BATCH_KIND.heavyDb)?.testBatches,
    ).toEqual(testPaths.slice(0, 2).map((testPath) => [testPath]));
    expect(
      groups.find(({ kind }) => kind === TEST_BATCH_KIND.db)?.maxPeakRssMb,
    ).toBe(2560);
    expect(
      groups.find(({ kind }) => kind === TEST_BATCH_KIND.db)?.testBatches,
    ).toEqual([["src/lib/lists/sanctions/monitoring-drain.db.test.ts"]]);
  });

  test("runs a solo file alone without regrouping any other batch", () => {
    const batches = composeTestBatches(
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
      dbTestBatchSize(false),
    );

    expect(splitSoloTests(batches, new Set(["b.test.ts"]))).toEqual([
      ["a.test.ts", "c.test.ts"],
      ["b.test.ts"],
      ["d.test.ts", "e.test.ts"],
    ]);
  });

  test("the runner's plan gives every solo file a batch of its own", async () => {
    const testPaths = listApiTestPaths(API_ROOT);
    const batches = (
      await planApiTestBatches({
        apiRoot: API_ROOT,
        propertyOnly: false,
        testPaths,
      })
    ).flatMap(({ testBatches }) => testBatches);

    for (const soloPath of SOLO_TEST_PATHS) {
      expect(batches.filter((batch) => batch.includes(soloPath))).toEqual([
        [soloPath],
      ]);
    }
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
      'process.env.REDIS_URL ??= "redis://127.0.0.1:1";',
      'process.env.REDIS_URL += "?isolated=true";',
      'if (enabled) { process.env.REDIS_URL = "redis://127.0.0.1:1"; }',
      'const configured = (process.env.REDIS_URL = "redis://127.0.0.1:1");',
      '(() => { process.env.REDIS_URL = "redis://127.0.0.1:1"; })();',
      '(function () { process.env.REDIS_URL = "redis://127.0.0.1:1"; })();',
    ]) {
      expect(hasModuleScopeProcessEnvMutation(testPath, source)).toBe(true);
    }
    for (const source of [
      'const value = process.env["REDIS_URL"];',
      'test("scoped", () => { process.env["REDIS_URL"] = "value"; });',
      'const deferred = () => { process.env.REDIS_URL = "value"; };',
      'function deferred() { process.env.REDIS_URL = "value"; }',
      '// process.env["REDIS_URL"] = "value";',
    ]) {
      expect(hasModuleScopeProcessEnvMutation(testPath, source)).toBe(false);
    }
  });
});

test("property selection includes both assertion APIs and excludes ordinary tests", async () => {
  const apiRoot = mkdtempSync(path.join(tmpdir(), "api-property-selectors-"));
  const legacyPath = "src/legacy.test.ts";
  const sharedPath = "src/shared.test.ts";
  const expectedPaths = [legacyPath, sharedPath];
  const ordinaryPath = "src/ordinary.test.ts";
  try {
    mkdirSync(path.join(apiRoot, "src"));
    await Promise.all([
      Bun.write(path.join(apiRoot, legacyPath), "fc.assert(property);"),
      Bun.write(
        path.join(apiRoot, sharedPath),
        'assertProperty("shared", property);',
      ),
      Bun.write(
        path.join(apiRoot, ordinaryPath),
        'test("ordinary", () => {});',
      ),
    ]);
    const batches = await planApiTestBatches({
      apiRoot,
      propertyOnly: true,
      testPaths: [...expectedPaths, ordinaryPath],
    });
    expect(
      batches.flatMap(({ testBatches }) => testBatches.flat()).toSorted(),
    ).toEqual(expectedPaths);
  } finally {
    rmSync(apiRoot, { recursive: true, force: true });
  }
});
