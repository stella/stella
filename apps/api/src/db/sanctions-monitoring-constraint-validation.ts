import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { OnlineRepair } from "./online-migration-connection";

export const SANCTIONS_MONITORING_CONSTRAINTS = [
  {
    tableName: "sanctions_contact_marks",
    constraintName: "sanctions_contact_marks_attempt_count_check",
  },
  {
    tableName: "contacts",
    constraintName: "contacts_sanctions_monitoring_mode_check",
  },
  {
    tableName: "organization_settings",
    constraintName: "organization_settings_sanctions_monitoring_mode_check",
  },
  {
    tableName: "sanctions_contact_matches",
    constraintName: "sanctions_contact_matches_disposition_check",
  },
  {
    tableName: "sanctions_screening_events",
    constraintName: "sanctions_screening_events_type_check",
  },
  {
    tableName: "sanctions_contact_screenings",
    constraintName: "sanctions_contact_screenings_status_check",
  },
  {
    tableName: "sanctions_contact_screenings",
    constraintName: "sanctions_contact_screenings_incomplete_edition_check",
  },
] as const satisfies readonly OnlineConstraintValidation[];

// Defaults and widened value sets satisfy these checks; validate outside the schema transaction so the
// scan holds no additive DDL lock. Catalog completion makes retries converge.
export const SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS =
  SANCTIONS_MONITORING_CONSTRAINTS.map(
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
