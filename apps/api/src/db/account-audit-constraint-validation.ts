import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const ACCOUNT_AUDIT_CONSTRAINT = {
  tableName: "account_audit_logs",
  constraintName: "account_audit_logs_event_type_check",
} as const satisfies OnlineConstraintValidation;

export const ACCOUNT_AUDIT_CONSTRAINT_VALIDATION = {
  name: ACCOUNT_AUDIT_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...ACCOUNT_AUDIT_CONSTRAINT,
      repairName: ACCOUNT_AUDIT_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [ACCOUNT_AUDIT_CONSTRAINT],
    }),
} satisfies OnlineRepair;
