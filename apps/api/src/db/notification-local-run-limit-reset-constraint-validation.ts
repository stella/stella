import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The kind and entity-type checks migration
 * 20261109170000_chat_limit_reminders widens to accept the
 * `local_run_limit_reset` kind and its `chat_thread` pointer, re-added NOT VALID.
 */
export const NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINTS = [
  {
    tableName: "notifications",
    constraintName: "notifications_kind_check",
    introducedBy: "20261109170000_chat_limit_reminders",
  },
  {
    tableName: "notifications",
    constraintName: "notifications_entity_type_check",
    introducedBy: "20261109170000_chat_limit_reminders",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINT_VALIDATIONS =
  NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINTS.map(
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
