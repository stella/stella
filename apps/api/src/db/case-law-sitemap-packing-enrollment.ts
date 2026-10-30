import { panic } from "better-result";
import * as v from "valibot";

import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import { lockBackfillCheckpoint } from "@/api/lib/db/aggregate-lock";

import {
  setDedicatedLockTimeout,
  setDedicatedStatementTimeout,
} from "./dedicated-connection-timeouts";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const NAME = "case-law-sitemap-packing-enrollment";
const COMPLETE = "complete";
const COUNTRIES_PER_BATCH = 100;
const checkpointSchema = v.object({ last_country: v.nullable(v.string()) });
const countrySchema = v.object({ country: v.string() });

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  const row = (
    await connection.query(
      "SELECT cursor AS last_country FROM public.database_backfill_states WHERE name = $1 LIMIT 1",
      [NAME],
    )
  ).at(0);
  return row !== undefined &&
    v.parse(checkpointSchema, row).last_country === COMPLETE
    ? { type: "complete" }
    : {
        type: "incomplete",
        reason: "existing sitemap countries need packing invalidations",
      };
};

/** One index descent per country; dense months never turn discovery into a shard scan. */
const countryPage = async (
  connection: OnlineMigrationConnection,
  cursor: string | null,
) =>
  (
    await connection.query(
      `
    WITH RECURSIVE countries AS (
      (SELECT country FROM public.case_law_sitemap_shards
       ${cursor === null ? "" : "WHERE country > $1"}
       ORDER BY country LIMIT 1)
      UNION ALL
      SELECT next.country FROM countries
      CROSS JOIN LATERAL (
        SELECT country FROM public.case_law_sitemap_shards
        WHERE country > countries.country ORDER BY country LIMIT 1
      ) next
    )
    SELECT country FROM countries LIMIT ${COUNTRIES_PER_BATCH}
  `,
      cursor === null ? [] : [cursor],
    )
  ).map((row) => v.parse(countrySchema, row).country);

/** The online owner holds its session lock; the checkpoint row also serializes batches. */
const enrollBatch = async (
  connection: OnlineMigrationConnection,
): Promise<"pending" | "complete"> => {
  await connection.execute("BEGIN");
  // This raw-connection boundary owns rollback, including a cancelled statement.
  try {
    await setDedicatedLockTimeout(connection.execute, 1000);
    await setDedicatedStatementTimeout(connection.execute, 30_000);
    await connection.execute(
      `
      INSERT INTO public.database_backfill_states (name, cursor, batch)
      VALUES ($1, NULL, $2::text::jsonb) ON CONFLICT (name) DO NOTHING
    `,
      [NAME, JSON.stringify(initialBatchState(defaultConfig))],
    );
    const row =
      (await lockBackfillCheckpoint(connection, NAME)).at(0) ??
      panic("Missing sitemap enrollment checkpoint");
    const { last_country: cursor } = v.parse(checkpointSchema, row);
    if (cursor === COMPLETE) {
      await connection.execute("COMMIT");
      return "complete";
    }
    const countries = await countryPage(connection, cursor);
    if (countries.length > 0) {
      await connection.execute(
        `
        INSERT INTO public.case_law_sitemap_changes (country, year, month)
        SELECT country, '*', '*' FROM jsonb_array_elements_text($1::text::jsonb) AS enrollment(country)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.case_law_sitemap_changes pending
          WHERE pending.country = enrollment.country AND pending.year = '*' AND pending.month = '*'
        )
        ON CONFLICT ON CONSTRAINT case_law_sitemap_changes_month_xact_key DO NOTHING
      `,
        [JSON.stringify(countries)],
      );
    }
    const next =
      countries.length < COUNTRIES_PER_BATCH
        ? COMPLETE
        : (countries.at(-1) ?? panic("Missing sitemap country cursor"));
    await connection.execute(
      `
      UPDATE public.database_backfill_states SET cursor = $2, updated_at = now() WHERE name = $1
    `,
      [NAME, next],
    );
    await connection.execute("COMMIT");
    return next === COMPLETE ? "complete" : "pending";
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

export const CASE_LAW_SITEMAP_PACKING_ENROLLMENT = {
  introducedBy: "20261030161200_sitemap_language_changes",
  name: NAME,
  readCompletion,
  repair: async (connection) => {
    for (;;) {
      if ((await enrollBatch(connection)) === "complete") {
        return { type: "complete" };
      }
    }
  },
} satisfies MigrationOwnedOnlineRepair;
