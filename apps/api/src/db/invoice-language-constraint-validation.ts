import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

/** Checks migration 20261019020000_invoice_language adds NOT VALID. */
export const INVOICE_LANGUAGE_CONSTRAINTS = [
  {
    tableName: "invoices",
    constraintName: "invoices_language_check",
    introducedBy: "20261019020000_invoice_language",
  },
  {
    tableName: "contacts",
    constraintName: "contacts_invoice_language_check",
    introducedBy: "20261019020000_invoice_language",
  },
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_invoice_language_check",
    introducedBy: "20261019020000_invoice_language",
  },
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

export const INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS =
  INVOICE_LANGUAGE_CONSTRAINTS.map(
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
