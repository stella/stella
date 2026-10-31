import { panic } from "better-result";

import { NODE_ENV, readRuntimeMode } from "@stll/runtime-mode";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

/** The owner database a file deletion's legal-hold fence runs on. */
export type OrganizationFileDeletionDb = Pick<MaintenanceDb, "transaction">;

let hermeticDeletionDb: OrganizationFileDeletionDb | undefined;

/**
 * Hermetic test processes have no shared database pool, so their setup
 * installs the fence database once (src/tests/setup-env.ts). Only a test
 * process may install one; every other process fences on the root pool.
 */
export const installHermeticOrganizationFileDeletionDb = (
  database: OrganizationFileDeletionDb,
): void => {
  if (readRuntimeMode().nodeEnv !== NODE_ENV.test) {
    panic("Only a test process installs the file deletion fence database");
  }
  hermeticDeletionDb = database;
};

/** The fence database for a deletion whose caller injected none. */
export const openOrganizationFileDeletionDb =
  async (): Promise<OrganizationFileDeletionDb> => {
    if (hermeticDeletionDb !== undefined) {
      return hermeticDeletionDb;
    }
    const { openOrganizationFileUsageDb } =
      await import("@/api/lib/db/maintenance-db");
    return openOrganizationFileUsageDb();
  };
