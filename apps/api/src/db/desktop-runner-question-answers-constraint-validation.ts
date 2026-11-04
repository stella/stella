import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The command kind, event request and chat turn interaction checks migration
 * 20261104001100_desktop_runner_question_answers widens to accept the
 * `run.answer` command, a question's request id on its event, and a turn
 * waiting on a harness question, re-added NOT VALID.
 */
export const DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINTS = [
  {
    tableName: "desktop_runner_commands",
    constraintName: "desktop_runner_commands_kind_check",
    introducedBy: "20261104001100_desktop_runner_question_answers",
  },
  {
    tableName: "desktop_runner_events",
    constraintName: "desktop_runner_events_request_check",
    introducedBy: "20261104001100_desktop_runner_question_answers",
  },
  {
    tableName: "chat_turns",
    constraintName: "chat_turns_interaction_values_check",
    introducedBy: "20261104001100_desktop_runner_question_answers",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINT_VALIDATIONS =
  DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINTS.map(
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
