import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The feature id check migration 20261106090700_local_agents_self_serve widens
 * to accept local agents as a self-serve feature, re-added NOT VALID.
 */
export const FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINTS = [
  {
    tableName: "feature_enrolments",
    constraintName: "feature_enrolments_feature_id_check",
    introducedBy: "20261106090700_local_agents_self_serve",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINT_VALIDATIONS =
  FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINTS.map(
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
