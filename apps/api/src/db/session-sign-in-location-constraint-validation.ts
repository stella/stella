import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const SESSION_SIGN_IN_LOCATION_CONSTRAINT = {
  tableName: "session_sign_ins",
  constraintName: "session_sign_ins_location_check",
  introducedBy: "20261121030000_session_sign_ins_known_country",
} as const satisfies OnlineConstraintValidation & { introducedBy: string };

export const SESSION_SIGN_IN_LOCATION_CONSTRAINT_VALIDATION = {
  name: SESSION_SIGN_IN_LOCATION_CONSTRAINT.constraintName,
  introducedBy: SESSION_SIGN_IN_LOCATION_CONSTRAINT.introducedBy,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: SESSION_SIGN_IN_LOCATION_CONSTRAINT.tableName,
      constraintName: SESSION_SIGN_IN_LOCATION_CONSTRAINT.constraintName,
      repairName: SESSION_SIGN_IN_LOCATION_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [SESSION_SIGN_IN_LOCATION_CONSTRAINT],
    }),
} satisfies OnlineRepair;
