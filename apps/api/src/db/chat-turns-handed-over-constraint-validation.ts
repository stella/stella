import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The status and state payload checks migration
 * 20261116020000_chat_turns_handed_over widens to accept a turn handed over
 * by its owner, re-added NOT VALID.
 */
export const CHAT_TURNS_HANDED_OVER_CONSTRAINTS = [
  {
    tableName: "chat_turns",
    constraintName: "chat_turns_status_values_check",
    introducedBy: "20261116020000_chat_turns_handed_over",
  },
  {
    tableName: "chat_turns",
    constraintName: "chat_turns_state_payload_check",
    introducedBy: "20261116020000_chat_turns_handed_over",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const CHAT_TURNS_HANDED_OVER_CONSTRAINT_VALIDATIONS =
  CHAT_TURNS_HANDED_OVER_CONSTRAINTS.map(
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
