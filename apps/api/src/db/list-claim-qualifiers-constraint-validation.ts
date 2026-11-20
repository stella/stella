import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "legal_list_claims";
const CONSTRAINT_NAME = "legal_list_claims_qualifiers_check";

/**
 * The claim qualifiers check migration
 * 20261110120000_legal_list_claim_qualifiers adds NOT VALID. It only
 * constrains the column that migration adds, so existing rows already pass.
 */
export const LIST_CLAIM_QUALIFIERS_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const LIST_CLAIM_QUALIFIERS_CONSTRAINT_VALIDATION = {
  introducedBy: "20261110120000_legal_list_claim_qualifiers",
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
      constraints: LIST_CLAIM_QUALIFIERS_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
