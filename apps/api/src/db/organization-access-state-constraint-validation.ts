import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "organization_access_states";

export const ORGANIZATION_ACCESS_STATE_CONSTRAINTS = [
  {
    tableName: TABLE_NAME,
    constraintName: "organization_access_states_origin_domain",
  },
  { tableName: TABLE_NAME, constraintName: "organization_access_states_shape" },
] as const satisfies readonly OnlineConstraintValidation[];

export const ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS =
  ORGANIZATION_ACCESS_STATE_CONSTRAINTS.map(
    ({ tableName, constraintName }) =>
      ({
        name: constraintName,
        readCompletion: async (connection) =>
          await readConstraintCompletion({
            connection,
            tableName,
            constraintName,
            repairName: constraintName,
          }),
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [{ tableName, constraintName }],
          }),
      }) satisfies OnlineRepair,
  );
