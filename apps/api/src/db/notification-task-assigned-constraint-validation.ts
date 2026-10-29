import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The kind and entity-type checks migration
 * 20261029100000_notification_task_assigned widens to accept the
 * `task_assigned` kind and its `task` pointer, re-added NOT VALID.
 */
export const NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS = [
  { tableName: "notifications", constraintName: "notifications_kind_check" },
  {
    tableName: "notifications",
    constraintName: "notifications_entity_type_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

export const NOTIFICATION_TASK_ASSIGNED_CONSTRAINT_VALIDATIONS =
  NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS.map(
    (constraint) =>
      ({
        name: constraint.constraintName,
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
