import { describe, expect, test } from "bun:test";

import {
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  findSharedTableDdlViolations,
  isolateSharedTableDdlTests,
} from "./postgres-test-plan";

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
