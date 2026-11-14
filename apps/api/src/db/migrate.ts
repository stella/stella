import { panic } from "better-result";
import nodePath from "node:path";

import { printError } from "@stll/errors";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

// Relative imports: this entrypoint also ships as a loose file without tsconfig.
import { resolveDatabaseUrl } from "../db-url";
import { envDbLoadGate } from "../env-db-load-gate";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";
import { runMigrationsUntilSettled } from "./migration-runner";
import {
  assertOnlineRepairRehearsalCoverage,
  parseOnlineRepairRehearsalArguments,
} from "./online-migration-rehearsal-guard";
import type { OnlineRepairRehearsalRecord } from "./online-migration-rehearsal-guard";
import { prepareOnlineRepairRehearsalReport } from "./online-migration-rehearsal-report";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";
import { createSqlClient } from "./sql-client";

const reportPath = parseOnlineRepairRehearsalArguments(process.argv.slice(2));

// An index build would hold forever on a load gate nobody configured, and the
// deploy waits on this process: reject that before any connection opens.
const ebs = requireEbsConfiguration(resolveEbsConfiguration(envDbLoadGate));
if (ebs.isErr()) {
  printError("[migrate] failed:", ebs.error);
  process.exit(1);
}

const url = resolveDatabaseUrl();
if (!url) {
  panic(
    "migrate: no database connection; set DATABASE_URL or the DB_* components",
  );
}

await runScriptWithErrorOutput(async () => {
  const report =
    reportPath === null ? null : prepareOnlineRepairRehearsalReport(reportPath);
  const observations: OnlineRepairRehearsalRecord[] = [];
  const client = createSqlClient({ url, max: 1 });
  // The loose source and single-file bundle both resolve drizzle from this file.
  const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
  const connection = await client.reserve();
  try {
    const result = await runMigrationsUntilSettled({
      connection,
      databaseUrl: url,
      migrationsFolder,
      ebs: ebs.value,
      observeRepair:
        report === null ? undefined : (record) => observations.push(record),
    });
    if (report !== null) {
      if (result.status !== "applied") {
        panic("Online repair rehearsal report requires an applied upgrade");
      }
      assertOnlineRepairRehearsalCoverage({
        records: observations,
        repairs: ONLINE_MIGRATION_REPAIRS,
      });
    }
    if (result.status === "applied") {
      // oxlint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface
      console.info("[migrate] migrations applied");
    }
  } finally {
    await connection.release();
    await client.end();
  }
  // Publish only after the upgrade, coverage and database cleanup all succeed.
  report?.publish(observations);
});
