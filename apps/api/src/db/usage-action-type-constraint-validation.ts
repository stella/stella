import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "usage_events";
const CONSTRAINT_NAME = "usage_events_action_type_domain";

export const USAGE_ACTION_TYPE_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const USAGE_ACTION_TYPE_CONSTRAINT_VALIDATION = {
  introducedBy: "20261031030947_transcription_usage_action",
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
      constraints: USAGE_ACTION_TYPE_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
