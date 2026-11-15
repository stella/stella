/**
 * Online repair behind migration
 * 20261031200638_case_law_source_ingestion_config_grant. Per-source state is
 * written with jsonb_set, which fails on a scalar, and some sources hold the
 * JSON string "{}" in `case_law_sources.config` instead of an object. This
 * stores the empty object they mean.
 *
 * One statement: the table holds one row per registered source, so the update
 * is bounded by the source registry, not by corpus size. Only the exact string
 * "{}" is rewritten; any other value has no known meaning and stays. A
 * rewritten row leaves the predicate, so completion reads it and a retried run
 * finds nothing. The object-only constraint follows once no such row is left:
 * added before, it would refuse every write to these rows until this ran.
 */
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
} from "./online-migration-connection";

const LEGACY_STRING_CONFIG = `jsonb_typeof(config) = 'string' AND config #>> '{}' = '{}'`;

const hasLegacyStringConfig = async (connection: OnlineMigrationConnection) =>
  (
    await connection.query(
      `SELECT 1 FROM public.case_law_sources WHERE ${LEGACY_STRING_CONFIG} LIMIT 1`,
    )
  ).length > 0;

export const CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR = {
  introducedBy: "20261031200638_case_law_source_ingestion_config_grant",
  name: "case_law_source_string_config",
  readCompletion: async (connection) =>
    (await hasLegacyStringConfig(connection))
      ? {
          type: "incomplete",
          reason: 'case_law_sources.config still holds the JSON string "{}"',
        }
      : { type: "complete" },
  repair: async (connection) => {
    await connection.query(
      `UPDATE public.case_law_sources SET config = '{}'::jsonb
        WHERE ${LEGACY_STRING_CONFIG}`,
    );
    return { type: "complete" };
  },
} as const satisfies MigrationOwnedOnlineRepair;
