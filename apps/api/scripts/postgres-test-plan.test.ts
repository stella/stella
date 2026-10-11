import { describe, expect, test } from "bun:test";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import {
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  findSharedTableDdlViolations,
  isolateSharedTableDdlTests,
} from "./postgres-test-plan";
import { discoverGatedTestFiles } from "./run-gated-tests";

const SHARED_TABLES = new Set(["contacts", "organization_settings"]);

describe("PostgreSQL shared-table DDL isolation", () => {
  test("rejects a non-isolated PostgreSQL DDL test and names every target", () => {
    const testPath = "src/example.postgres.test.ts";
    const violations = findSharedTableDdlViolations({
      sources: new Map([
        [
          testPath,
          `
            await db.execute(sql\`DROP TRIGGER fixture ON public.contacts\`);
            await db.execute(sql\`ALTER TABLE "public"."organization_settings" DROP COLUMN fixture\`);
          `,
        ],
      ]),
      sharedTables: SHARED_TABLES,
      isolatedPaths: new Set(),
    });

    expect(violations).toEqual([
      { testPath, tables: ["contacts", "organization_settings"] },
    ]);
  });

  test("detects every target of TRUNCATE and DROP TABLE lists, with or without TABLE", () => {
    for (const statement of [
      "TRUNCATE contacts",
      "TRUNCATE TABLE fixture, contacts RESTART IDENTITY CASCADE",
      'TRUNCATE ONLY fixture, "public"."contacts"',
      "DROP TABLE IF EXISTS fixture, public.contacts",
      // Adjacent statements without semicolons each keep their own targets.
      'const statements = ["TRUNCATE fixture", "TRUNCATE contacts"]',
      'db.execute("DROP TABLE fixture")\ndb.execute("LOCK contacts")',
    ]) {
      expect(
        findSharedTableDdlViolations({
          sources: new Map([["src/example.postgres.test.ts", statement]]),
          sharedTables: SHARED_TABLES,
          isolatedPaths: new Set(),
        }),
        statement,
      ).toEqual([
        { testPath: "src/example.postgres.test.ts", tables: ["contacts"] },
      ]);
    }
  });

  test("detects every DDL form that names its table after ON, and LOCK lists", () => {
    for (const statement of [
      "CREATE OR REPLACE TRIGGER fixture BEFORE INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION f()",
      "CREATE CONSTRAINT TRIGGER fixture AFTER INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION f()",
      "ALTER TRIGGER fixture ON contacts RENAME TO other",
      'DROP TRIGGER IF EXISTS fixture ON "public"."contacts"',
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fixture ON ONLY contacts (id)",
      "CREATE OR REPLACE RULE fixture AS ON INSERT TO contacts DO NOTHING",
      "CREATE POLICY fixture ON contacts USING (true)",
      "DROP POLICY IF EXISTS fixture ON contacts",
      "LOCK TABLE fixture, contacts IN ACCESS EXCLUSIVE MODE",
      "LOCK contacts",
    ]) {
      expect(
        findSharedTableDdlViolations({
          sources: new Map([["src/example.postgres.test.ts", statement]]),
          sharedTables: SHARED_TABLES,
          isolatedPaths: new Set(),
        }),
        statement,
      ).toEqual([
        { testPath: "src/example.postgres.test.ts", tables: ["contacts"] },
      ]);
    }
  });

  test("accepts shared-table DDL only when its file is isolated", () => {
    const testPath =
      "src/lib/lists/sanctions/monitoring-migrations.postgres.test.ts";
    expect(
      findSharedTableDdlViolations({
        sources: new Map([
          [testPath, "DROP TRIGGER fixture ON public.contacts"],
        ]),
        sharedTables: SHARED_TABLES,
        isolatedPaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
      }),
    ).toEqual([]);
  });

  test("runs each shared-table DDL file after the ordinary batch", () => {
    const isolated = "src/isolated.postgres.test.ts";
    expect(
      isolateSharedTableDdlTests(
        ["src/first.postgres.test.ts", isolated, "src/last.postgres.test.ts"],
        new Set([isolated]),
      ),
    ).toEqual([
      ["src/first.postgres.test.ts", "src/last.postgres.test.ts"],
      [isolated],
    ]);
  });
});

describe("PostgreSQL shared batch", () => {
  // Every shared-batch file reuses one process and one cached auth instance,
  // so a module mock there arrives after another file built auth and never
  // reaches it.
  test("contains no module mocks", async () => {
    const apiRoot = path.resolve(import.meta.dir, "..");
    const runner = packageJson.ciGateTestRunners["test:postgres"];
    const sharedFiles = (
      await discoverGatedTestFiles({
        apiRoot,
        gate: runner.gate,
        testFileGlob: runner.testFileGlob,
      })
    ).filter(
      (testPath) => !EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS.has(testPath),
    );
    expect(sharedFiles.length).toBeGreaterThan(0);
    const mocking: string[] = [];
    for (const testPath of sharedFiles) {
      const source = await Bun.file(path.join(apiRoot, testPath)).text();
      if (/\bmock\.module\s*\(/u.test(source)) {
        mocking.push(testPath);
      }
    }
    expect(
      mocking,
      `These PostgreSQL suites call mock.module in the shared test process; move the mocked cases to a .db.test.ts file, which runs in its own process:\n${mocking.join("\n")}`,
    ).toEqual([]);
  });
});
