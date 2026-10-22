import { panic } from "better-result";
import { SQL } from "bun";
import { appendFileSync } from "node:fs";
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

const rehearsalReportFlag = process.argv.indexOf(
  "--rehearsal-online-repair-report",
);
const rehearsalReport =
  rehearsalReportFlag === -1
    ? undefined
    : (process.argv.at(rehearsalReportFlag + 1) ??
      panic("--rehearsal-online-repair-report requires a path"));

await runScriptWithErrorOutput(async () => {
  const client = new SQL({ url, max: 1 });
  // The loose source and single-file bundle both resolve drizzle from this file.
  const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
  const connection = await client.reserve();
  try {
    const result = await runMigrationsUntilSettled({
      connection,
      databaseUrl: url,
      migrationsFolder,
      ebs: ebs.value,
      repairAttemptObserver:
        rehearsalReport === undefined
          ? undefined
          : (record) => {
              appendFileSync(rehearsalReport, `${JSON.stringify(record)}\n`);
            },
    });
    if (result.status === "applied") {
      // oxlint-disable-next-line no-console -- migrate CLI entrypoint; stdout is its interface
      console.info("[migrate] migrations applied");
    }
  } finally {
    connection.release();
    await client.end();
  }
});
