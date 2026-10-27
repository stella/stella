import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "user";
const CONSTRAINT_NAME = "user_email_undeliverable_check";

export const EMAIL_UNDELIVERABLE_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const EMAIL_UNDELIVERABLE_CONSTRAINT_VALIDATION = {
  name: CONSTRAINT_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: TABLE_NAME,
      constraintName: CONSTRAINT_NAME,
      repairName: CONSTRAINT_NAME,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: EMAIL_UNDELIVERABLE_CONSTRAINTS,
    }),
} as const satisfies OnlineRepair;
