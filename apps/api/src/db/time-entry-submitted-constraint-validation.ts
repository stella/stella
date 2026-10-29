import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The internal-entry shape check migration
 * 20261026230000_time_entry_submitted_status widens to accept `submitted`
 * and re-adds NOT VALID.
 */
const TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT = {
  tableName: "time_entries",
  constraintName: "time_entries_internal_shape_check",
} as const satisfies OnlineConstraintValidation;

export const TIME_ENTRY_SUBMITTED_CONSTRAINTS = [
  TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT,
] as const satisfies readonly OnlineConstraintValidation[];

export const TIME_ENTRY_SUBMITTED_CONSTRAINT_VALIDATION = {
  name: TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT.tableName,
      constraintName: TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT.constraintName,
      repairName: TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [TIME_ENTRY_INTERNAL_SHAPE_CONSTRAINT],
    }),
} as const satisfies OnlineRepair;
