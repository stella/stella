import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const LEGISLATION_MATTER_LINK_CONSTRAINTS = [
  "legislation_matter_links_document_fk",
  "legislation_matter_links_workspace_id_workspaces_id_fkey",
  "legislation_matter_links_linked_by_user_id_fkey",
].map(
  (constraintName) =>
    ({
      tableName: "legislation_matter_links",
      constraintName,
      introducedBy: "20261031120615_legislation_matter_links",
    }) satisfies OnlineConstraintValidation & { introducedBy: string },
);

export const LEGISLATION_MATTER_LINK_CONSTRAINT_VALIDATIONS =
  LEGISLATION_MATTER_LINK_CONSTRAINTS.map(
    ({ tableName, constraintName, introducedBy }) =>
      ({
        name: constraintName,
        introducedBy,
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
