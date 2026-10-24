import { IMPORT_PROVENANCE_TABLES } from "./import-provenance-columns";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const IMPORT_PROVENANCE_CONSTRAINTS = IMPORT_PROVENANCE_TABLES.map(
  (tableName) =>
    ({
      tableName,
      constraintName: `${tableName}_external_ref_check`,
    }) satisfies OnlineConstraintValidation,
);

export const IMPORT_PROVENANCE_CONSTRAINT_VALIDATIONS =
  IMPORT_PROVENANCE_CONSTRAINTS.map(
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
      }) satisfies OnlineRepair,
  );
