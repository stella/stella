import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const ACCOUNT_AUDIT_CONSTRAINT = {
  tableName: "account_audit_logs",
  constraintName: "account_audit_logs_event_type_check",
  introducedBy: "20261029094225_sign_in_method_audit_event",
} as const satisfies OnlineConstraintValidation & { introducedBy: string };

export const ACCOUNT_AUDIT_CONSTRAINT_VALIDATION = {
  name: ACCOUNT_AUDIT_CONSTRAINT.constraintName,
  introducedBy: ACCOUNT_AUDIT_CONSTRAINT.introducedBy,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: ACCOUNT_AUDIT_CONSTRAINT.tableName,
      constraintName: ACCOUNT_AUDIT_CONSTRAINT.constraintName,
      repairName: ACCOUNT_AUDIT_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [ACCOUNT_AUDIT_CONSTRAINT],
    }),
} satisfies OnlineRepair;
