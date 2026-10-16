import { readConstraintCompletion } from "./online-constraint-completion";
import type { OnlineRepair } from "./online-migration-connection";

const CONSTRAINTS = [
  {
    introducedBy: "20261004120300_sanctions_drain_retry",
    tableName: "sanctions_contact_marks",
    constraintName: "sanctions_contact_marks_attempt_count_check",
  },
  {
    introducedBy: "20261003122800_sanctions_monitoring",
    tableName: "contacts",
    constraintName: "contacts_sanctions_monitoring_mode_check",
  },
  {
    introducedBy: "20261003122800_sanctions_monitoring",
    tableName: "organization_settings",
    constraintName: "organization_settings_sanctions_monitoring_mode_check",
  },
  {
    introducedBy: "20261003122800_sanctions_monitoring",
    tableName: "sanctions_contact_matches",
    constraintName: "sanctions_contact_matches_disposition_check",
  },
  {
    introducedBy: "20261003122800_sanctions_monitoring",
    tableName: "sanctions_screening_events",
    constraintName: "sanctions_screening_events_type_check",
  },
  {
    introducedBy: "20261003122800_sanctions_monitoring",
    tableName: "sanctions_contact_screenings",
    constraintName: "sanctions_contact_screenings_status_check",
  },
  {
    introducedBy: "20261015202900_sanctions_screening_incomplete_status",
    tableName: "sanctions_contact_screenings",
    constraintName: "sanctions_contact_screenings_incomplete_edition_check",
  },
] as const;

// Defaults and widened value sets satisfy these checks; validate outside the schema transaction so the
// scan holds no additive DDL lock. Catalog completion makes retries converge.
export const SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS = CONSTRAINTS.map(
  ({ introducedBy, tableName, constraintName }) =>
    ({
      introducedBy,
      name: constraintName,
      readCompletion: async (connection) =>
        await readConstraintCompletion({
          connection,
          tableName,
          constraintName,
          repairName: constraintName,
        }),
      repair: async (connection) => {
        await connection.execute(
          `ALTER TABLE public."${tableName}" VALIDATE CONSTRAINT "${constraintName}"`,
        );
      },
    }) satisfies OnlineRepair,
);
