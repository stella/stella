import { panic } from "better-result";
import * as v from "valibot";

import { initialBatchState } from "@stll/db-load-gate/health";

import { loadGateHealthConfig } from "@/api/env-online-index";
import { lockBackfillCheckpoint } from "@/api/lib/db/aggregate-lock";

import {
  setDedicatedLockTimeout,
  setDedicatedStatementTimeout,
} from "./dedicated-connection-timeouts";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const COMPLETE = "complete";
const SITEMAP_RANGES_MIGRATION = "20261115170000_case_law_sitemap_ranges";
const COUNTRIES_PER_BATCH = 100;
const checkpointSchema = v.object({ last_country: v.nullable(v.string()) });
const countrySchema = v.object({ country: v.string() });

const readCompletion = async (
  connection: OnlineMigrationConnection,
  name: string,
  reason: string,
): Promise<OnlineRepairCompletion> => {
  const row = (
    await connection.query(
      "SELECT cursor AS last_country FROM public.database_backfill_states WHERE name = $1 LIMIT 1",
      [name],
    )
  ).at(0);
  return row !== undefined &&
    v.parse(checkpointSchema, row).last_country === COMPLETE
    ? { type: "complete" }
    : { type: "incomplete", reason };
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
  name: string,
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
      [name, JSON.stringify(initialBatchState(loadGateHealthConfig()))],
    );
    const row =
      (await lockBackfillCheckpoint(connection, name)).at(0) ??
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
      [name, next],
    );
    await connection.execute("COMMIT");
    return next === COMPLETE ? "complete" : "pending";
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

/**
 * Queue a recount of every country the sitemap lists, once, after a change
 * to how a month is cut: each country gets one whole-country change row, which
 * the refresh expands into its months and recounts under the new rule.
 */
const caseLawSitemapEnrollment = ({
  introducedBy,
  name,
  reason,
}: {
  introducedBy: string;
  name: string;
  reason: string;
}) =>
  ({
    introducedBy,
    name,
    readCompletion: async (connection) =>
      await readCompletion(connection, name, reason),
    repair: async (connection) => {
      for (;;) {
        if ((await enrollBatch(connection, name)) === "complete") {
          return { type: "complete" };
        }
      }
    },
  }) satisfies MigrationOwnedOnlineRepair;

export const CASE_LAW_SITEMAP_PACKING_ENROLLMENT = caseLawSitemapEnrollment({
  introducedBy: "20261030161200_sitemap_language_changes",
  name: "case-law-sitemap-packing-enrollment",
  reason: "existing sitemap countries need packing invalidations",
});

/** Months split into hashed buckets, or not split at all, are cut into ranges. */
export const CASE_LAW_SITEMAP_RANGE_ENROLLMENT = caseLawSitemapEnrollment({
  introducedBy: SITEMAP_RANGES_MIGRATION,
  name: "case-law-sitemap-range-enrollment",
  reason: "existing sitemap countries need their months cut into ranges",
});

/** Each listed file is the whole month or a bounded range, never a mix. */
export const CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT = {
  tableName: "case_law_sitemap_shards",
  constraintName: "case_law_sitemap_shards_range_bounds",
} as const;

export const CASE_LAW_SITEMAP_RANGE_BOUNDS_VALIDATION = {
  name: CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT.constraintName,
  introducedBy: SITEMAP_RANGES_MIGRATION,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT,
      repairName: CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT],
    }),
} satisfies MigrationOwnedOnlineRepair;
