import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { CASE_LAW_POPULATION_SEED_REPAIR_NAME } from "../lib/case-law/population-count-limits";
import { withGatedTestClients } from "../tests/gated-test-database";
import { CASE_LAW_POPULATION_REPAIR } from "./case-law-population-repair";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** The heavy-work lock every backfill batch takes for its transaction. */
const HEAVY_WORK_LOCK = "1937007724::int, 0::int";

describe.skipIf(!enabled)("case-law population seed repair", () => {
  test("defers the phase when another session holds the heavy-work slot", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const other = openClient().sql;
      const migrating = await openClient().sql.reserve();
      await other.unsafe(`SELECT pg_advisory_lock(${HEAVY_WORK_LOCK})`);
      try {
        const outcome = await CASE_LAW_POPULATION_REPAIR.repair({
          execute: async (query, params = []) => {
            await migrating.unsafe(query, [...params]);
          },
          query: async (query, params = []) =>
            await migrating.unsafe(query, [...params]),
          release: () => undefined,
        });
        expect(outcome).toEqual({
          type: "deferred",
          step: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
          retryAfterMs: expect.any(Number),
        });
      } finally {
        await other.unsafe(`SELECT pg_advisory_unlock(${HEAVY_WORK_LOCK})`);
        await migrating.unsafe(
          "DELETE FROM public.database_backfill_states WHERE name = $1",
          [CASE_LAW_POPULATION_SEED_REPAIR_NAME],
        );
        await migrating.release();
      }
    });
  });
});
