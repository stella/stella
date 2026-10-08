import { Result, TaggedError } from "better-result";

import { printError } from "@stll/errors";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

import { parseReplayProviderEventsArguments } from "./replay-provider-events-arguments";
import { resolveReplayPerformer } from "./replay-provider-events-performer";
import { runReplayReport } from "./replay-provider-events-runner";

class ReplayProviderEventsRunError extends TaggedError(
  "ReplayProviderEventsRunError",
)<{ message: string; cause?: unknown }> {}

if (process.argv.slice(2).includes("--help")) {
  process.stdout.write(
    "Usage: replay-provider-events [--event-id ID ...] [--ids-file PATH] --results PATH [--apply --requested-by LABEL --reason TEXT]\n" +
      "Select at least one --event-id or an --ids-file. Defaults to dry run: simulates the ordered batch in one transaction, then rolls it back. --requested-by is a claimed operator label, required with --apply.\n" +
      "Select every related unresolved receipt; partial selections and elapsed allocations are skipped. Ignored attempts may be retried; other replay outcomes are terminal.\n" +
      "Performer is derived from the ECS task ARN or local OS user. ECS identity failure refuses replay.\n",
  );
  process.exit(0);
}

const parsed = parseReplayProviderEventsArguments(process.argv.slice(2));
if (Result.isError(parsed)) {
  printError(parsed.error);
  process.exit(1);
}

const { ids, mode, resultsPath, requestedBy, reason } = parsed.value;
const identity = await resolveReplayPerformer({
  metadataUri: process.env["ECS_CONTAINER_METADATA_URI_V4"],
  executionEnvironment: process.env["AWS_EXECUTION_ENV"],
});
if (Result.isError(identity)) {
  printError(identity.error);
  process.exit(1);
}
const performer = identity.value;
let maintenanceDb: MaintenanceDb | undefined;

const reportResult = await Result.tryPromise({
  try: async () =>
    await runReplayReport({
      ids,
      mode,
      resultsPath,
      execution: {
        type: "batch",
        replayBatch: async (onRow) => {
          const [{ replayProviderEventsBatch }, { openMaintenanceDb }] =
            await Promise.all([
              import("@/api/handlers/hosted-usage-webhook/replay"),
              import("@/api/lib/db/maintenance-db"),
            ]);
          let db = maintenanceDb;
          if (db === undefined) {
            db = openMaintenanceDb({ readOnly: false });
            maintenanceDb = db;
          }
          const result = await replayProviderEventsBatch({
            eventIds: ids,
            mode,
            performer,
            requestedBy,
            reason,
            onRow,
            runTransaction: async (callback) => await db.transaction(callback),
          });
          if (Result.isError(result)) {
            throw result.error;
          }
        },
      },
    }),
  catch: (cause) =>
    new ReplayProviderEventsRunError({
      message:
        "Replay stopped before all rows completed; check the results file and database access.",
      cause,
    }),
});
if (Result.isError(reportResult)) {
  printError(reportResult.error);
  process.exit(1);
}
const report = reportResult.value;

const completed = report.rows.length - report.failed;
process.stdout.write(
  `provider event replay: mode=${mode} total=${report.rows.length} completed=${completed} failed=${report.failed}\n` +
    `provider event replay results: ${resultsPath}\n`,
);
if (report.status === "failed") {
  process.stderr.write("One or more provider events could not be replayed.\n");
}
process.exit(report.status === "complete" ? 0 : 1);
