import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The notification kind and entity-type checks, re-added NOT VALID each time a
 * migration widens them: 20261031194952_notification_task_assigned for the
 * `task_assigned` kind and its `task` pointer, then
 * 20261113013547_chat_limit_reminders for `local_run_limit_reset` and its
 * `chat_thread` pointer. One repair per check validates it after the newest
 * widening, so `introducedBy` names that migration.
 */
export const NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS = [
  {
    tableName: "notifications",
    constraintName: "notifications_kind_check",
    introducedBy: "20261113013547_chat_limit_reminders",
  },
  {
    tableName: "notifications",
    constraintName: "notifications_entity_type_check",
    introducedBy: "20261113013547_chat_limit_reminders",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const NOTIFICATION_TASK_ASSIGNED_CONSTRAINT_VALIDATIONS =
  NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS.map(
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
