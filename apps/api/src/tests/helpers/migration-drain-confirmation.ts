import { parseMigrationDrainConfirmation } from "../../env-migration";

/** Scratch fixtures own every session and have no scheduler workers to drain. */
export const ISOLATED_MIGRATION_DRAIN = parseMigrationDrainConfirmation(
  "Isolated migration test database has no scheduler workers",
).unwrap();
