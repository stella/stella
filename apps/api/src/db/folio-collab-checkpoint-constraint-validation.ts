import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "folio_collab_rooms";
const CONSTRAINT_NAME = "folio_collab_rooms_checkpoint_size_check";

/**
 * The checkpoint size check migration
 * 20261112223000_folio_collab_checkpoint_document_limit replaces NOT VALID
 * with a higher bound. It only widens the check, so existing rows already
 * pass.
 */
export const FOLIO_COLLAB_CHECKPOINT_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

export const FOLIO_COLLAB_CHECKPOINT_CONSTRAINT_VALIDATION = {
  introducedBy: "20261112223000_folio_collab_checkpoint_document_limit",
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
      constraints: FOLIO_COLLAB_CHECKPOINT_CONSTRAINTS,
    }),
} satisfies OnlineRepair;
