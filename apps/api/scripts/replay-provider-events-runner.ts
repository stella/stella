import { panic, Result, TaggedError } from "better-result";
import { closeSync, openSync, writeFileSync } from "node:fs";

import type { ProviderEventReplayRow } from "@/api/handlers/hosted-usage-webhook/replay";

export type ProviderEventReplayMode = ProviderEventReplayRow["mode"];
export const PROVIDER_EVENT_REPLAY_MODES = {
  dryRun: "dry_run",
  apply: "apply",
} as const satisfies Record<string, ProviderEventReplayMode>;

type ReplayAttempt =
  | { type: "ok"; row: ProviderEventReplayRow }
  | { type: "error"; error: { message: string } };

export class ReplayAttemptError extends TaggedError("ReplayAttemptError")<{
  message: string;
  cause: unknown;
}> {}

// Defer telemetry initialization so argument/identity refusals need no API setup.
type ObserveUnexpectedFailureOptions = {
  error: ReplayAttemptError;
  mode: ProviderEventReplayMode;
  eventId: string;
};
const observeUnexpectedFailure = async ({
  error,
  mode,
  eventId,
}: ObserveUnexpectedFailureOptions) => {
  const [{ observeFailure }, { failureSink }] = await Promise.all([
    import("@/api/lib/observability/observe-failure"),
    import("@/api/lib/observability/failure"),
  ]);
  observeFailure(error, {
    sink: failureSink({
      event: "usage_provider.replay.runner_failed",
      expected: [],
    }),
    ctx: { source: "usage_provider.replay", mode, requestId: eventId },
  });
};

// Dispatch reasons can quote provider values, so they stay out of stdout logs;
// the results file keeps them.
const stdoutLine = ({ reason: _reason, ...row }: ProviderEventReplayRow) =>
  JSON.stringify(row);

type RunReplayReportOptions = {
  ids: string[];
  mode: ProviderEventReplayMode;
  resultsPath: string;
  writeStdout?: (chunk: string) => void;
  observeUnexpectedFailure?: typeof observeUnexpectedFailure;
  execution:
    | { type: "per_event"; replayEvent: (id: string) => Promise<ReplayAttempt> }
    | {
        type: "batch";
        replayBatch: (
          emitRow: (row: ProviderEventReplayRow) => void,
        ) => Promise<void>;
      };
};

export const runReplayReport = async ({
  ids,
  mode,
  resultsPath,
  execution,
  writeStdout = (chunk) => process.stdout.write(chunk),
  observeUnexpectedFailure: observe = observeUnexpectedFailure,
}: RunReplayReportOptions) => {
  const fd = openSync(resultsPath, "wx", 0o600);
  const rows: ProviderEventReplayRow[] = [];
  // Stream rows inside a fenced JSON Lines block, like the usage policy seed,
  // so a one-off task's results survive in its stdout logs after it exits.
  writeStdout("```jsonl\n");
  const emitRow = (row: ProviderEventReplayRow) => {
    rows.push(row);
    writeFileSync(fd, `${JSON.stringify(row)}\n`);
    writeStdout(`${stdoutLine(row)}\n`);
  };
  try {
    switch (execution.type) {
      case "per_event":
        for (const id of ids) {
          const result = await Result.tryPromise({
            try: async () => await execution.replayEvent(id),
            catch: (cause) =>
              new ReplayAttemptError({
                message: "Replay failed unexpectedly; check operator logs.",
                cause,
              }),
          });
          if (Result.isError(result)) {
            await observe({ error: result.error, mode, eventId: id });
          }
          const attempt = Result.isError(result)
            ? { type: "error" as const, error: result.error }
            : result.value;
          emitRow(
            attempt.type === "ok"
              ? attempt.row
              : {
                  id,
                  previousResult: null,
                  kind: "error",
                  reason: attempt.error.message,
                  mode,
                },
          );
        }
        break;
      case "batch": {
        const result = await Result.tryPromise({
          try: async () => await execution.replayBatch(emitRow),
          catch: (cause) =>
            new ReplayAttemptError({
              message: "Replay batch failed; check operator logs.",
              cause,
            }),
        });
        if (Result.isError(result)) {
          await observe({ error: result.error, mode, eventId: "batch" });
          throw result.error;
        }
        break;
      }
      default:
        execution satisfies never;
        return panic("Unhandled replay execution mode");
    }
    const failed = rows.filter(({ kind }) => kind === "error").length;
    return {
      status: failed === 0 ? ("complete" as const) : ("failed" as const),
      rows,
      lines: rows.map((row) => JSON.stringify(row)).join("\n"),
      failed,
    };
  } finally {
    writeStdout("```\n");
    closeSync(fd);
  }
};
