/**
 * Online repair behind migration 20261031082700_case_law_source_config_object,
 * which holds `case_law_sources.config` to a JSON object (NOT VALID). That
 * migration already stores the object a legacy JSON string "{}" meant and
 * refuses any other non-object row, so this only validates the constraint;
 * a non-object row written another way fails validation and surfaces.
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
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT],
    }),
} as const satisfies MigrationOwnedOnlineRepair;
