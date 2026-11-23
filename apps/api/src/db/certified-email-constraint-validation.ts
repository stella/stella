import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The certification data check the certified email channel adds NOT VALID;
 * the online phase validates it through the contention gate. The channel and
 * direction checks it replaces in the same migration stay with the data-box
 * validations, which own their names.
 */
export const CERTIFIED_EMAIL_CONSTRAINT = {
  tableName: "correspondence",
  constraintName: "correspondence_certified_email_check",
  introducedBy: "20261123050000_correspondence_pec_channel",
} as const satisfies OnlineConstraintValidation & { introducedBy: string };

export const CERTIFIED_EMAIL_CONSTRAINT_VALIDATION = {
  name: CERTIFIED_EMAIL_CONSTRAINT.constraintName,
  introducedBy: CERTIFIED_EMAIL_CONSTRAINT.introducedBy,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: CERTIFIED_EMAIL_CONSTRAINT.tableName,
      constraintName: CERTIFIED_EMAIL_CONSTRAINT.constraintName,
      repairName: CERTIFIED_EMAIL_CONSTRAINT.constraintName,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: [CERTIFIED_EMAIL_CONSTRAINT],
    }),
} satisfies OnlineRepair;
