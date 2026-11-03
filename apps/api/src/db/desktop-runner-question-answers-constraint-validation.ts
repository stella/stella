import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/**
 * The command kind and event request checks migration
 * 20261103180000_desktop_runner_question_answers widens to accept the
 * `run.answer` command and a question's request id on its event, re-added
 * NOT VALID.
 */
export const DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINTS = [
  {
    tableName: "desktop_runner_commands",
    constraintName: "desktop_runner_commands_kind_check",
    introducedBy: "20261103180000_desktop_runner_question_answers",
  },
  {
    tableName: "desktop_runner_events",
    constraintName: "desktop_runner_events_request_check",
    introducedBy: "20261103180000_desktop_runner_question_answers",
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
