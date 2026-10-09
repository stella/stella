import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/bun";

import { parseQueryPerfBaselineFile } from "./baseline";
import { withQueryPerfFixture } from "./fixture";
import {
  budgetViolations,
  measureQueryPerf,
  shapeViolations,
} from "./measurement";
import { QUERY_PERF_PROFILES } from "./profiles";
import { queryPerfRegistry } from "./registry";
import { QUERY_PERF_SEED_ID, seedQueryPerf } from "./seed";
import { QUERY_PERF_SETTINGS } from "./settings";

const enabled = process.env["STELLA_RUN_QUERY_PERF_TESTS"] === "true";
const SETTINGS_DIGEST = sha256Hex(JSON.stringify(QUERY_PERF_SETTINGS));

describe.skipIf(!enabled)("query perf gate on PostgreSQL under RLS", () => {
  test("both document-search profiles pass and a correlated policy exceeds each buffer budget", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined) {
      return panic("DATABASE_URL required for query perf");
    }
    const recording = process.env["QUERY_PERF_RECORD_BASELINE"] === "true";
    const baseline = recording
      ? null
      : parseQueryPerfBaselineFile(
          await Bun.file(new URL("baseline.json", import.meta.url)).json(),
        );
    if (
      baseline !== null &&
      (baseline.seedId !== QUERY_PERF_SEED_ID ||
        baseline.settingsDigest !== SETTINGS_DIGEST)
    ) {
      return panic(
        "Query perf baseline seed or planner settings differ; record and review a new baseline",
      );
    }
    const recorded: Record<
      string,
      { sharedBlocks: number; executionTimeMs: number }
    > = {};
    const measuredIds: string[] = [];
    for (const profileId of QUERY_PERF_PROFILES) {
      // db-await-in-loop: fresh profile databases must be seeded and measured sequentially to avoid benchmark contention.
      await withQueryPerfFixture({
        databaseUrl,
        profileId,
        run: async (db) => {
          const seed = await seedQueryPerf(db, profileId);
          for (const [entryId, entry] of Object.entries(
            queryPerfRegistry(seed),
          )) {
            const id = `${profileId}-${entryId}`;
            measuredIds.push(id);
            const expected = baseline?.entries[id];
            if (!recording && expected === undefined) {
              return panic(`Missing baseline for ${id}`);
            }
            // db-await-in-loop: one bounded registry measurement at a time, avoiding cross-query benchmark contention.
            const good = await measureQueryPerf({
              database: db,
              seed,
              query: entry.query,
            });
            expect(good.plan.Plan["Actual Rows"]).toBe(entry.expectedRows);
            expect(shapeViolations(good.plan, profileId)).toEqual([]);
            recorded[id] = good.metrics;
            if (expected === undefined) {
              continue;
            }
            expect(budgetViolations(good.metrics, expected)).toEqual([]);
            console.info(
              JSON.stringify({
                event: "query_perf_measurement",
                profileId,
                entryId,
                ...good.metrics,
                baseline: expected,
                nearBufferBudget:
                  good.metrics.sharedBlocks >=
                  expected.sharedBlocks * 1.25 * 0.95,
              }),
            );
            try {
              await db.execute(sql`CREATE POLICY query_perf_correlated_fixture ON search_documents AS RESTRICTIVE FOR SELECT TO stella USING (
              (SELECT count(*) FROM entities policy_entity WHERE policy_entity.id = search_documents.entity_id) > 0
            )`);
              const bad = await measureQueryPerf({
                database: db,
                seed,
                query: entry.query,
              });
              // The fixture must reach the policy and fail the measured budget, independently of shape checks.
              expect(shapeViolations(bad.plan, profileId)).toContain(
                "per-row policy subplan on search_documents",
              );
              expect(budgetViolations(bad.metrics, expected)).toContain(
                "shared buffer budget exceeded",
              );
            } finally {
              await db.execute(
                sql`DROP POLICY IF EXISTS query_perf_correlated_fixture ON search_documents`,
              );
            }
          }
        },
      });
    }
    if (baseline !== null) {
      expect(Object.keys(baseline.entries).toSorted()).toEqual(
        measuredIds.toSorted(),
      );
    }
    if (recording) {
      await Bun.write(
        new URL("baseline.json", import.meta.url),
        `${JSON.stringify(
          {
            seedId: QUERY_PERF_SEED_ID,
            settingsDigest: SETTINGS_DIGEST,
            entries: recorded,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 240_000);
});
