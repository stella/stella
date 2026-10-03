import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { usagePolicies } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runSeedReport } from "./seed-usage-policies-runner";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgres)("usage policy seed outcomes (postgres)", () => {
  test("PostgreSQL reports committed insert, replay, update, hiding and rollback outcomes", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const dir = mkdtempSync(nodePath.join(tmpdir(), "policy-postgres-"));
      // Session-local table shadows the migrated schema without retiring other fixtures.
      await db.execute(
        sql`CREATE TEMP TABLE usage_policies (LIKE public.usage_policies INCLUDING ALL)`,
      );
      const policy = {
        key: "retained",
        displayName: "Sample",
        monthlyUsageUnits: 10,
        visibility: "public",
        hostedPolicyRef: "sample-ref",
      };
      const retired = {
        ...policy,
        key: "retired",
        hostedPolicyRef: "retired-ref",
      };
      try {
        const inserted = await runSeedReport({
          input: JSON.stringify([policy, retired]),
          resultsPath: nodePath.join(dir, "insert.jsonl"),
          openDb: () => db,
        });
        expect(inserted.rows.map((row) => row.outcome)).toEqual([
          "inserted",
          "inserted",
        ]);
        const replay = await runSeedReport({
          input: JSON.stringify([policy, retired]),
          resultsPath: nodePath.join(dir, "replay.jsonl"),
          openDb: () => db,
        });
        expect(replay.rows.map((row) => row.outcome)).toEqual([
          "unchanged",
          "unchanged",
        ]);
        const updated = await runSeedReport({
          input: JSON.stringify([
            { ...policy, storageBytesPerAssignment: 100 },
          ]),
          resultsPath: nodePath.join(dir, "updated.jsonl"),
          openDb: () => db,
        });
        expect(updated.rows).toEqual([
          { policyKey: "retained", outcome: "updated" },
          { policyKey: "retired", outcome: "hidden" },
        ]);
        const path = nodePath.join(dir, "failed.jsonl");
        const failed = await runSeedReport({
          input: JSON.stringify([
            { ...policy, monthlyUsageUnits: 20 },
            { ...policy, key: "collision" },
          ]),
          resultsPath: path,
          openDb: () => db,
        });
        expect(failed.status).toBe("failed");
        expect(failed.rows.map((row) => row.outcome)).toEqual([
          "failed",
          "failed",
        ]);
        expect(readFileSync(path, "utf-8")).not.toContain("sample-ref");
        expect(
          await db
            .select({
              key: usagePolicies.policyKey,
              units: usagePolicies.monthlyUsageUnits,
            })
            .from(usagePolicies)
            .orderBy(usagePolicies.policyKey),
        ).toEqual([
          { key: "retained", units: 10 },
          { key: "retired", units: 10 },
        ]);
      } finally {
        await db.execute(sql`DROP TABLE pg_temp.usage_policies`);
        rmSync(dir, { recursive: true });
      }
    });
  });
});
