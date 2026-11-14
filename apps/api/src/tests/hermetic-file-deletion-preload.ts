import { NODE_ENV, readRuntimeMode } from "@stll/runtime-mode";

import { installHermeticOrganizationFileDeletionDb } from "../lib/files/organization-file-deletion-db";
import { holdFreeFileDeletionDb } from "./hold-free-file-deletion-db";
import { runsAgainstSharedTestDatabase } from "./test-database-environment";

// A test-only preload (bunfig.toml `[test].preload`): generators and tooling
// that load setup-env outside the test runner never reach it. Hermetic suites
// have no shared database pool, so file deletions fence on a database where
// nothing is held; the Postgres suites keep the root pool and its real legal
// holds.
if (
  readRuntimeMode().nodeEnv === NODE_ENV.test &&
  !runsAgainstSharedTestDatabase()
) {
  installHermeticOrganizationFileDeletionDb(holdFreeFileDeletionDb);
}
