import { Result } from "better-result";

import { readConstraintCompletion } from "./online-constraint-completion";
import type { OnlineRepair } from "./online-migration-connection";

const CONSTRAINT_NAME = "organization_settings_ai_instructions_length_check";

export const ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINT_VALIDATION = {
  name: CONSTRAINT_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: "organization_settings",
      constraintName: CONSTRAINT_NAME,
      repairName: CONSTRAINT_NAME,
    }),
  repair: async (connection) => {
    // The schema transaction has committed before the online phase starts;
    // validation therefore retains no lock from adding the column and CHECK.
    await connection.execute("BEGIN");
    const outcome = await Result.tryPromise({
      try: async () => {
        await connection.execute("SET LOCAL lock_timeout = '1s'");
        await connection.execute("SET LOCAL statement_timeout = '10s'");
        await connection.execute(
          `ALTER TABLE public."organization_settings" VALIDATE CONSTRAINT "${CONSTRAINT_NAME}"`,
        );
        await connection.execute("COMMIT");
      },
      catch: (cause: unknown) => cause,
    });
    if (Result.isOk(outcome)) {
      return;
    }
    await connection.execute("ROLLBACK");
    throw outcome.error;
  },
} satisfies OnlineRepair;
