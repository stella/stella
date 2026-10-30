import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type { MigrationOwnedOnlineRepair } from "./online-migration-connection";

export const SANCTIONS_MONITORING_CONSTRAINTS = [
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
] as const satisfies readonly (OnlineConstraintValidation & {
  introducedBy: string;
})[];

// Defaults and widened value sets satisfy these checks; validate outside the schema transaction so the
// scan holds no additive DDL lock. Catalog completion makes retries converge.
const createConstraintValidation = <
  const Constraint extends OnlineConstraintValidation & {
    introducedBy: string;
  },
>(
  constraint: Constraint,
): MigrationOwnedOnlineRepair & {
  readonly name: Constraint["constraintName"];
} =>
  ({
    introducedBy: constraint.introducedBy,
    name: constraint.constraintName,
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
  }) as const satisfies MigrationOwnedOnlineRepair;

export const SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS = [
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[0]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[1]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[2]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[3]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[4]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[5]),
  createConstraintValidation(SANCTIONS_MONITORING_CONSTRAINTS[6]),
] as const satisfies readonly MigrationOwnedOnlineRepair[];
