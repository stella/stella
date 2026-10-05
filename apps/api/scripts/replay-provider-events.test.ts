import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  MAX_PROVIDER_EVENT_REPLAY_IDS,
  MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES,
  parseReplayProviderEventsArguments,
} from "./replay-provider-events-arguments";
import {
  ReplayAttemptError,
  runReplayReport,
} from "./replay-provider-events-runner";

const temporaryDirectory = () =>
  mkdtempSync(nodePath.join(tmpdir(), "provider-event-replay-"));

test("defaults to dry run and deduplicates explicit IDs and IDs-file entries", async () => {
  const dir = temporaryDirectory();
  try {
    const idsFile = nodePath.join(dir, "ids.txt");
    await Bun.write(idsFile, "event-b\nevent-c\n");
    const parsed = parseReplayProviderEventsArguments([
      "--event-id",
      "event-a",
      "--event-id",
      "event-b",
      "--ids-file",
      idsFile,
      "--results",
      nodePath.join(dir, "results.jsonl"),
      "--requested-by",
      "operator@example.test",
    ]);

    expect(Result.isError(parsed)).toBe(false);
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    expect(parsed.value).toEqual({
      ids: ["event-a", "event-b", "event-c"],
      mode: "dry_run",
      resultsPath: nodePath.join(dir, "results.jsonl"),
      requestedBy: "operator@example.test",
      reason: "Operator requested a dry run.",
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("requires a claimed requester and a reason for apply mode", () => {
  const resultPath = "/tmp/provider-event-results.jsonl";
  const missingRequester = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    resultPath,
    "--apply",
  ]);
  expect(Result.isError(missingRequester)).toBe(true);
  if (Result.isError(missingRequester)) {
    expect(missingRequester.error.message).toBe(
      "--requested-by is required with --apply.",
    );
  }

  const missingReason = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    resultPath,
    "--requested-by",
    "operator",
    "--apply",
  ]);
  expect(Result.isError(missingReason)).toBe(true);
  if (Result.isError(missingReason)) {
    expect(missingReason.error.message).toBe(
      "--reason is required with --apply.",
    );
  }

  const applyWithReason = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    resultPath,
    "--requested-by",
    "operator",
    "--reason",
    "Operator selected replay",
    "--apply",
  ]);
  expect(Result.isError(applyWithReason)).toBe(false);
  if (!Result.isError(applyWithReason)) {
    expect(applyWithReason.value.mode).toBe("apply");
    expect(applyWithReason.value.reason).toBe("Operator selected replay");
  }
});

test("requires an explicit selection and rejects malformed IDs and unknown flags", () => {
  const dir = temporaryDirectory();
  const base = [
    "--results",
    nodePath.join(dir, "results.jsonl"),
    "--requested-by",
    "operator",
  ];
  try {
    const noSelection = parseReplayProviderEventsArguments(base);
    expect(Result.isError(noSelection)).toBe(true);
    if (Result.isError(noSelection)) {
      expect(noSelection.error.message).toContain("Provide at least one");
    }

    const emptyIdsFile = nodePath.join(dir, "empty.txt");
    writeFileSync(emptyIdsFile, "\n  \n");
    const emptySelection = parseReplayProviderEventsArguments([
      "--ids-file",
      emptyIdsFile,
      ...base,
    ]);
    expect(Result.isError(emptySelection)).toBe(true);
    if (Result.isError(emptySelection)) {
      expect(emptySelection.error.message).toContain("list is empty");
    }

    const whitespaceId = parseReplayProviderEventsArguments([
      "--event-id",
      "  ",
      ...base,
    ]);
    expect(Result.isError(whitespaceId)).toBe(true);
    if (Result.isError(whitespaceId)) {
      expect(whitespaceId.error.message).toContain("non-empty");
    }

    const nulId = parseReplayProviderEventsArguments([
      "--event-id",
      "event\0id",
      ...base,
    ]);
    expect(Result.isError(nulId)).toBe(true);

    const unknownFlag = parseReplayProviderEventsArguments(["--all", ...base]);
    expect(Result.isError(unknownFlag)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("bounds the file and number of selected event IDs", () => {
  const dir = temporaryDirectory();
  try {
    const idsFile = nodePath.join(dir, "oversized.txt");
    writeFileSync(
      idsFile,
      "x".repeat(MAX_PROVIDER_EVENT_REPLAY_IDS_FILE_BYTES + 1),
    );
    const tooManyFromFile = parseReplayProviderEventsArguments([
      "--ids-file",
      idsFile,
      "--results",
      nodePath.join(dir, "results.jsonl"),
      "--requested-by",
      "operator",
    ]);
    expect(Result.isError(tooManyFromFile)).toBe(true);
    if (Result.isError(tooManyFromFile)) {
      expect(tooManyFromFile.error.message).toContain("must not exceed");
    }

    const tooManyIds = parseReplayProviderEventsArguments([
      ...Array.from(
        { length: MAX_PROVIDER_EVENT_REPLAY_IDS + 1 },
        (_, index) => ["--event-id", `event-${index}`],
      ).flat(),
      "--results",
      nodePath.join(dir, "too-many.jsonl"),
      "--requested-by",
      "operator",
    ]);
    expect(Result.isError(tooManyIds)).toBe(true);
    if (Result.isError(tooManyIds)) {
      expect(tooManyIds.error.message).toContain("At most 1000");
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("writes each row durably, continues after errors, and refuses overwrite", async () => {
  const dir = temporaryDirectory();
  const resultsPath = nodePath.join(dir, "results.jsonl");
  let firstRowWasDurableBeforeSecondReplay = false;
  const unexpectedCause = new Error("private database detail");
  let observedCause: unknown;
  try {
    const report = await runReplayReport({
      ids: ["event-ok", "event-error", "event-throw"],
      mode: "apply",
      resultsPath,
      observeUnexpectedFailure: async ({ error, mode, eventId }) => {
        observedCause = error.cause;
        expect(mode).toBe("apply");
        expect(eventId).toBe("event-throw");
      },
      execution: {
        type: "per_event",
        replayEvent: async (id) => {
          if (id === "event-error") {
            firstRowWasDurableBeforeSecondReplay = readFileSync(
              resultsPath,
              "utf-8",
            ).includes('"id":"event-ok"');
            return {
              type: "error",
              error: { message: "Replay is not applicable." },
            };
          }
          if (id === "event-throw") {
            throw unexpectedCause;
          }
          return {
            type: "ok",
            row: {
              id,
              previousResult: "ignored",
              kind: "applied",
              reason: null,
              mode: "apply",
            },
          };
        },
      },
    });

    expect(report.status).toBe("failed");
    expect(observedCause).toBe(unexpectedCause);
    expect(report.failed).toBe(2);
    expect(firstRowWasDurableBeforeSecondReplay).toBe(true);
    expect(report.rows.map(({ id, kind }) => [id, kind])).toEqual([
      ["event-ok", "applied"],
      ["event-error", "error"],
      ["event-throw", "error"],
    ]);
    expect(report.lines).not.toContain("private database detail");
    expect(
      readFileSync(resultsPath, "utf-8").split("\n").filter(Boolean),
    ).toHaveLength(3);
    const overwrite = await runReplayReport({
      ids: ["event-ok"],
      mode: "dry_run",
      resultsPath,
      execution: {
        type: "per_event",
        replayEvent: async () => {
          throw new Error("must not run");
        },
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(overwrite).toBeInstanceOf(Error);
    if (overwrite instanceof Error) {
      expect(overwrite.message).toContain("EEXIST");
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a results file open failure prevents any replay", async () => {
  const dir = temporaryDirectory();
  let replayed = false;
  try {
    const openFailure = await runReplayReport({
      ids: ["event-a"],
      mode: "dry_run",
      resultsPath: nodePath.join(dir, "missing", "results.jsonl"),
      execution: {
        type: "per_event",
        replayEvent: async () => {
          replayed = true;
          return { type: "error", error: { message: "not relevant" } };
        },
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(openFailure).toBeInstanceOf(Error);
    if (openFailure instanceof Error) {
      expect(openFailure.message).toContain("ENOENT");
    }
    expect(replayed).toBe(false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("builds and copies the standalone replay command into the API image", () => {
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf-8",
  );
  expect(dockerfile).toContain("--outfile /app/replay-provider-events.js");
  expect(dockerfile).toContain("apps/api/scripts/replay-provider-events.ts");
  expect(dockerfile).toContain(
    "COPY --chown=stella:stella --from=builder /app/replay-provider-events.js /app/replay-provider-events.js",
  );
});

test("dry run does not require a claimed requester", () => {
  const parsed = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    "/tmp/results.jsonl",
  ]);
  expect(parsed.unwrap().requestedBy).toBeNull();
});

test("ECS identity failure refuses replay before opening results or the database", async () => {
  const dir = temporaryDirectory();
  try {
    const resultsPath = nodePath.join(dir, "results.jsonl");
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("replay-provider-events.ts", import.meta.url).pathname,
        "--event-id",
        "event-a",
        "--results",
        resultsPath,
        "--apply",
        "--requested-by",
        "claimed-operator",
        "--reason",
        "fixture",
      ],
      env: {
        ...process.env,
        ECS_CONTAINER_METADATA_URI_V4: "http://127.0.0.1:0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain(
      "Could not resolve replay performer identity; replay refused.",
    );
    expect(await Bun.file(resultsPath).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("batch reporting writes rows durably and observes an unexpected batch cause", async () => {
  const dir = temporaryDirectory();
  const resultsPath = nodePath.join(dir, "results.jsonl");
  const cause = new Error("batch infrastructure detail");
  let observedCause: unknown;
  try {
    const failed = await runReplayReport({
      ids: ["event-a", "event-b"],
      mode: "dry_run",
      resultsPath,
      observeUnexpectedFailure: async ({ error, mode, eventId }) => {
        observedCause = error.cause;
        expect(mode).toBe("dry_run");
        expect(eventId).toBe("batch");
      },
      execution: {
        type: "batch",
        replayBatch: async (emitRow) => {
          emitRow({
            id: "event-a",
            previousResult: "ignored",
            kind: "applied",
            reason: null,
            mode: "dry_run",
          });
          expect(readFileSync(resultsPath, "utf-8")).toContain(
            '"id":"event-a"',
          );
          throw cause;
        },
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ReplayAttemptError);
    expect(observedCause).toBe(cause);
    expect(readFileSync(resultsPath, "utf-8")).not.toContain(
      "batch infrastructure detail",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const fencedRows = (stdout: string) => {
  const match = /^```jsonl\n(?<body>(?:.*\n)*?)```\n$/u.exec(stdout);
  if (match?.groups === undefined) {
    throw new TypeError(`stdout is not one fenced JSON Lines block: ${stdout}`);
  }
  return match.groups["body"]
    ?.split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
};

const fileRowsWithoutReason = (path: string) =>
  readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { reason: _reason, ...row }: Record<string, unknown> =
        JSON.parse(line);
      return row;
    });

test("prints every row to stdout in order, matching the results file without reasons", async () => {
  const dir = temporaryDirectory();
  const resultsPath = nodePath.join(dir, "results.jsonl");
  const providerReason = "no usage_policy matches provider-ref-sample";
  let stdout = "";
  try {
    const report = await runReplayReport({
      ids: ["event-a", "event-b", "event-c"],
      mode: "dry_run",
      resultsPath,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      execution: {
        type: "batch",
        replayBatch: async (emitRow) => {
          emitRow({
            id: "event-a",
            previousResult: "ignored",
            kind: "applied",
            reason: null,
            mode: "dry_run",
          });
          emitRow({
            id: "event-b",
            previousResult: "ignored",
            kind: "ignored",
            reason: providerReason,
            mode: "dry_run",
          });
          emitRow({
            id: "event-c",
            previousResult: "ignored",
            kind: "related_receipts_unselected",
            reason: "Select all related unresolved receipts",
            unselectedEventIds: ["event-d"],
            selectionStatus: "complete",
            mode: "dry_run",
          });
        },
      },
    });

    expect(report.rows).toHaveLength(3);
    expect(fencedRows(stdout)).toEqual(fileRowsWithoutReason(resultsPath));
    expect(fencedRows(stdout)).toHaveLength(3);
    expect(readFileSync(resultsPath, "utf-8")).toContain(providerReason);
    expect(stdout).not.toContain(providerReason);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("closes the stdout block with the rows emitted before a batch failure", async () => {
  const dir = temporaryDirectory();
  const resultsPath = nodePath.join(dir, "results.jsonl");
  let stdout = "";
  try {
    const failed = await runReplayReport({
      ids: ["event-a", "event-b"],
      mode: "apply",
      resultsPath,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      observeUnexpectedFailure: async () => {},
      execution: {
        type: "batch",
        replayBatch: async (emitRow) => {
          emitRow({
            id: "event-a",
            previousResult: "ignored",
            kind: "applied",
            reason: null,
            mode: "apply",
          });
          throw new Error("batch infrastructure detail");
        },
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(ReplayAttemptError);
    expect(fencedRows(stdout)).toEqual([
      {
        id: "event-a",
        previousResult: "ignored",
        kind: "applied",
        mode: "apply",
      },
    ]);
    expect(stdout).not.toContain("batch infrastructure detail");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
