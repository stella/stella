import { Result, TaggedError } from "better-result";
import { closeSync, openSync, writeFileSync } from "node:fs";

import type { ProviderEventReplayRow as CoreReplayRow } from "@/api/lib/hosted-usage-provider/replay";

export type ProviderEventReplayMode = CoreReplayRow["mode"];

export const PROVIDER_EVENT_REPLAY_MODES = {
  dryRun: "dry_run",
  apply: "apply",
} as const satisfies Record<string, ProviderEventReplayMode>;

type ProviderEventReplayRow =
  | CoreReplayRow
  | (Omit<CoreReplayRow, "kind" | "previousResult" | "reason"> & {
      kind: "error";
      previousResult: null;
      reason: string;
    });

type ReplayAttempt =
  | { type: "ok"; row: ProviderEventReplayRow }
  | { type: "error"; error: { message: string } };

class ReplayAttemptError extends TaggedError("ReplayAttemptError")<{
  message: string;
}> {}

type RunReplayReportOptions = {
  ids: string[];
  mode: ProviderEventReplayMode;
  resultsPath: string;
  replayEvent: (id: string) => Promise<ReplayAttempt>;
};

export const runReplayReport = async ({
  ids,
  mode,
  resultsPath,
  replayEvent,
}: RunReplayReportOptions) => {
  const fd = openSync(resultsPath, "wx", 0o600);
  const rows: ProviderEventReplayRow[] = [];
  try {
    for (const id of ids) {
      const attemptResult = await Result.tryPromise({
        try: async () => await replayEvent(id),
        catch: () =>
          new ReplayAttemptError({
            message: "Replay failed unexpectedly; check operator logs.",
          }),
      });
      const attempt = Result.isError(attemptResult)
        ? { type: "error" as const, error: attemptResult.error }
        : attemptResult.value;
      const row =
        attempt.type === "ok"
          ? attempt.row
          : ({
              id,
              previousResult: null,
              kind: "error" as const,
              reason: attempt.error.message,
              mode,
            } satisfies ProviderEventReplayRow);
      rows.push(row);
      writeFileSync(fd, `${JSON.stringify(row)}\n`);
    }
    const lines = rows.map((row) => JSON.stringify(row)).join("\n");
    const failed = rows.filter((row) => row.kind === "error").length;
    return {
      status: failed === 0 ? ("complete" as const) : ("failed" as const),
      rows,
      lines,
      failed,
    };
  } finally {
    closeSync(fd);
  }
};
