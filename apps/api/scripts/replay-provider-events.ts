import { Result, TaggedError } from "better-result";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

import { parseReplayProviderEventsArguments } from "./replay-provider-events-arguments";
import { runReplayReport } from "./replay-provider-events-runner";

class ReplayProviderEventsRunError extends TaggedError(
  "ReplayProviderEventsRunError",
)<{ message: string; cause?: unknown }> {}

const parsed = parseReplayProviderEventsArguments(process.argv.slice(2));
if (Result.isError(parsed)) {
  process.stderr.write(`${parsed.error.message}\n`);
  process.exit(1);
}

const { ids, mode, resultsPath, actor, reason } = parsed.value;
let maintenanceDb: MaintenanceDb | undefined;

const reportResult = await Result.tryPromise({
  try: async () =>
    await runReplayReport({
      ids,
      mode,
      resultsPath,
      replayEvent: async (eventId) => {
        const [{ replayProviderEvent }, { openMaintenanceDb }] =
          await Promise.all([
            import("@/api/handlers/hosted-usage-webhook/replay"),
            import("@/api/lib/db/maintenance-db"),
          ]);
        let db = maintenanceDb;
        if (db === undefined) {
          db = openMaintenanceDb({ readOnly: false });
          maintenanceDb = db;
        }
        const result = await replayProviderEvent({
          eventId,
          mode,
          actor,
          reason,
          runTransaction: async (callback) => await db.transaction(callback),
        });
        return Result.isError(result)
          ? { type: "error", error: result.error }
          : { type: "ok", row: result.value };
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
  process.stderr.write(`${reportResult.error.message}\n`);
  process.exit(1);
}
const report = reportResult.value;

const succeeded = report.rows.length - report.failed;
process.stdout.write(
  `provider event replay: mode=${mode} total=${report.rows.length} succeeded=${succeeded} failed=${report.failed}\n` +
    `provider event replay results: ${resultsPath}\n`,
);
if (report.status === "failed") {
  process.stderr.write("One or more provider events could not be replayed.\n");
}
process.exit(report.status === "complete" ? 0 : 1);
