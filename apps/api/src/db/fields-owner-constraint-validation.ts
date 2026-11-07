import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The cell ownership checks migration 20261107190000_fields_owner_shape adds
 * NOT VALID: a claim is held whole, and only a pending cell holds one.
 */
export const FIELDS_OWNER_CONSTRAINTS = [
  {
    tableName: "fields",
    constraintName: "fields_owner_fields_check",
    introducedBy: "20261107190000_fields_owner_shape",
  },
  {
    tableName: "fields",
    constraintName: "fields_owner_pending_check",
    introducedBy: "20261107190000_fields_owner_shape",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const FIELDS_OWNER_CONSTRAINT_VALIDATIONS = FIELDS_OWNER_CONSTRAINTS.map(
  (constraint) =>
    ({
      name: constraint.constraintName,
      introducedBy: constraint.introducedBy,
      readCompletion: async (connection) =>
        await readConstraintCompletion({
          connection,
          tableName: constraint.tableName,
          constraintName: constraint.constraintName,
          repairName: constraint.constraintName,
        }),
      repair: async (connection, tables) =>
        await validateOnlineConstraints({
          connection,
          tables,
          constraints: [constraint],
        }),
    }) satisfies OnlineRepair,
);
