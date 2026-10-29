import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** Migration 20261029222032 installs this check without scanning existing users. */
export const USER_LOCALE_CONSTRAINT = {
  tableName: "user",
  constraintName: "user_locale_supported_check",
} as const satisfies OnlineConstraintValidation;

export const USER_LOCALE_CONSTRAINT_VALIDATION = {
  introducedBy: "20261029222032_user_locale",
  name: USER_LOCALE_CONSTRAINT.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      ...USER_LOCALE_CONSTRAINT,
      repairName: USER_LOCALE_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [USER_LOCALE_CONSTRAINT],
    }),
} satisfies OnlineRepair;
