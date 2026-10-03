import { Result, TaggedError } from "better-result";
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  PROVIDER_EVENT_REPLAY_MODES,
  type ProviderEventReplayMode,
} from "./replay-provider-events-runner";

const DEFAULT_DRY_RUN_REASON = "Operator requested a dry run.";
export const MAX_PROVIDER_EVENT_REPLAY_IDS = 1000;
export const MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES = 1_000_000;

type ReplayProviderEventsArguments = {
  ids: string[];
  mode: ProviderEventReplayMode;
  resultsPath: string;
  requestedBy: string | null;
  reason: string;
};

class ReplayProviderEventsArgumentsError extends TaggedError(
  "ReplayProviderEventsArgumentsError",
)<{ message: string; cause?: unknown }> {}

const parseIdsFile = (path: string) => {
  const contents = readFileSync(path, "utf-8");
  if (
    Buffer.byteLength(contents, "utf-8") >
    MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES
  ) {
    throw new ReplayProviderEventsArgumentsError({
      message: `--ids-file must not exceed ${MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES} bytes.`,
    });
  }
  return contents
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
};

export const parseReplayProviderEventsArguments = (
  args: string[],
): Result<
  ReplayProviderEventsArguments,
  ReplayProviderEventsArgumentsError
> => {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args,
        options: {
          "event-id": { type: "string", multiple: true },
          "ids-file": { type: "string" },
          results: { type: "string" },
          "requested-by": { type: "string" },
          reason: { type: "string" },
          apply: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
      }),
    catch: (cause) =>
      new ReplayProviderEventsArgumentsError({
        message:
          cause instanceof Error ? cause.message : "Invalid replay arguments.",
        cause,
      }),
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  const { values } = parsed.value;
  if (values.results === undefined || values.results.trim().length === 0) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "--results is required.",
      }),
    );
  }
  if (values.apply && !values["requested-by"]?.trim()) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "--requested-by is required with --apply.",
      }),
    );
  }
  if (
    values.apply &&
    (values.reason === undefined || values.reason.trim().length === 0)
  ) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "--reason is required with --apply.",
      }),
    );
  }
  if (values.reason?.trim().length === 0) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "--reason must not be empty.",
      }),
    );
  }

  const eventIds = values["event-id"] ?? [];
  const idsFile = values["ids-file"];
  const noFileIds: string[] = [];
  const fileIdsResult =
    idsFile === undefined
      ? Result.ok(noFileIds)
      : Result.try({
          try: () => {
            if (
              statSync(idsFile).size > MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES
            ) {
              throw new ReplayProviderEventsArgumentsError({
                message: `--ids-file must not exceed ${MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES} bytes.`,
              });
            }
            return parseIdsFile(idsFile);
          },
          catch: (cause) =>
            cause instanceof ReplayProviderEventsArgumentsError
              ? cause
              : new ReplayProviderEventsArgumentsError({
                  message: "Could not read --ids-file.",
                  cause,
                }),
        });
  if (Result.isError(fileIdsResult)) {
    return Result.err(fileIdsResult.error);
  }
  if (eventIds.length === 0 && values["ids-file"] === undefined) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "Provide at least one --event-id or an --ids-file.",
      }),
    );
  }

  const ids = [
    ...new Set([...eventIds, ...fileIdsResult.value].map((id) => id.trim())),
  ];
  if (ids.some((id) => id.length === 0 || id.includes("\0"))) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "Event IDs must be non-empty text.",
      }),
    );
  }
  if (ids.length === 0) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: "The event ID list is empty.",
      }),
    );
  }
  if (ids.length > MAX_PROVIDER_EVENT_REPLAY_IDS) {
    return Result.err(
      new ReplayProviderEventsArgumentsError({
        message: `At most ${MAX_PROVIDER_EVENT_REPLAY_IDS} distinct event IDs can be replayed per run.`,
      }),
    );
  }

  return Result.ok({
    ids,
    mode: values.apply
      ? PROVIDER_EVENT_REPLAY_MODES.apply
      : PROVIDER_EVENT_REPLAY_MODES.dryRun,
    resultsPath: values.results,
    requestedBy: values["requested-by"]?.trim() || null,
    reason: values.reason?.trim() || DEFAULT_DRY_RUN_REASON,
  });
};
