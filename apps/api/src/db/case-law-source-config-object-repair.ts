/**
 * Online repair behind migration 20261031082700_case_law_source_config_object,
 * which holds `case_law_sources.config` to a JSON object (NOT VALID). Rows
 * written earlier can hold the JSON string "{}"; jsonb_set on that scalar
 * fails, so those sources could never record per-source state. This stores the
 * empty object they mean, then validates the constraint.
 *
 * One statement: the table holds one row per registered source, so the update
 * is bounded by the source registry, not by corpus size. Only the exact string
 * "{}" is rewritten; any other non-object row stays and fails validation, so it
 * surfaces instead of being guessed at. A rewritten row leaves the predicate,
 * so a retried run finds nothing.
 */
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { MigrationOwnedOnlineRepair } from "./online-migration-connection";

export const CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT = {
  tableName: "case_law_sources",
  constraintName: "case_law_sources_config_object",
} as const satisfies OnlineConstraintValidation;

export const CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR = {
  introducedBy: "20261031082700_case_law_source_config_object",
  name: CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT.tableName,
      constraintName: CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT.constraintName,
      repairName: CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) => {
    await connection.query(
      `UPDATE public.case_law_sources SET config = '{}'::jsonb
        WHERE jsonb_typeof(config) = 'string' AND config #>> '{}' = '{}'`,
    );
    return await validateOnlineConstraints({
      connection,
      tables,
      constraints: [CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT],
    });
  },
} as const satisfies MigrationOwnedOnlineRepair;
