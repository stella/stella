import { readConstraintCompletion } from "./online-constraint-completion";
import type { OnlineRepair } from "./online-migration-connection";

const CONSTRAINT_NAME = "legal_list_verification_runs_error_code_check";

export const LIST_VERIFICATION_CONSTRAINT_VALIDATION = {
  name: CONSTRAINT_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: "legal_list_verification_runs",
      constraintName: CONSTRAINT_NAME,
      repairName: CONSTRAINT_NAME,
    }),
  repair: async (connection) => {
    await connection.execute(
      'ALTER TABLE public."legal_list_verification_runs" VALIDATE CONSTRAINT "legal_list_verification_runs_error_code_check"',
    );
  },
} satisfies OnlineRepair;
