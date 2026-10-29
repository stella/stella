import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

const TABLE_NAME = "legal_reader_annotations";

export const READER_ANNOTATION_CONSTRAINTS = [
  {
    tableName: TABLE_NAME,
    constraintName: "legal_reader_annotations_target_type_values",
  },
  {
    tableName: TABLE_NAME,
    constraintName: "legal_reader_annotations_verification_claim_shape",
  },
  {
    tableName: TABLE_NAME,
    constraintName: "legal_reader_annotations_workspace_organization_fk",
  },
  {
    tableName: TABLE_NAME,
    constraintName: "legal_reader_annotations_matter_document_shape",
  },
] as const satisfies readonly OnlineConstraintValidation[];

// Migrations 20261021080000 (claim comments) and 20261026120000 (matter
// document marks, which also re-adds the target-type check) add these NOT
// VALID: rows written before them leave the new columns null, which every
// check accepts, and new rows are checked from the start. Validating here
// keeps the scan out of the schema transaction.
export const READER_ANNOTATION_CONSTRAINT_VALIDATIONS =
  READER_ANNOTATION_CONSTRAINTS.map(
    ({ tableName, constraintName }) =>
      ({
        name: constraintName,
        readCompletion: async (connection) =>
          await readConstraintCompletion({
            connection,
            tableName,
            constraintName,
            repairName: constraintName,
          }),
        repair: async (connection, tables) =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: [{ tableName, constraintName }],
          }),
      }) as const satisfies OnlineRepair,
  );
