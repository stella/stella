import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "legal_reader_answer_messages";
const CONSTRAINT_NAME = "legal_reader_answer_messages_error_code_values";

export const READER_ANSWER_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const READER_ANSWER_CONSTRAINT_VALIDATION = {
  name: CONSTRAINT_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      tableName: TABLE_NAME,
      constraintName: CONSTRAINT_NAME,
      repairName: CONSTRAINT_NAME,
    }),
  repair: async (connection, tables) =>
    await validateOnlineConstraints({
      connection,
      tables,
      constraints: READER_ANSWER_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
