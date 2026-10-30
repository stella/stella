import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "organization_access_states";

export const ORGANIZATION_ACCESS_STATE_CONSTRAINTS = [
  {
    tableName: TABLE_NAME,
    constraintName: "organization_access_states_origin_domain",
    introducedBy: "20261023160000_organization_access_state_origin",
  },
  {
    tableName: TABLE_NAME,
    constraintName: "organization_access_states_shape",
    introducedBy: "20261028120000_keyless_organization_free_floor",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS =
  ORGANIZATION_ACCESS_STATE_CONSTRAINTS.map(
    ({ tableName, constraintName, introducedBy }) =>
      ({
        name: constraintName,
        introducedBy,
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
