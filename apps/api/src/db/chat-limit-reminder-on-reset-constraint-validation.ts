import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The check of what a limit reminder does when it is due, which migration
 * 20261116160100_chat_limit_reminder_on_reset adds NOT VALID.
 */
export const CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINTS = [
  {
    tableName: "chat_limit_reminders",
    constraintName: "chat_limit_reminders_on_reset_check",
    introducedBy: "20261116160100_chat_limit_reminder_on_reset",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINT_VALIDATIONS =
  CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINTS.map(
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
