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
import { runReplayReport } from "./replay-provider-events-runner";

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
      "--actor",
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
      actor: "operator@example.test",
      reason: "Operator requested a dry run.",
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("requires an actor and a reason for apply mode", () => {
  const resultPath = "/tmp/provider-event-results.jsonl";
  const missingActor = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    resultPath,
    "--apply",
  ]);
  expect(Result.isError(missingActor)).toBe(true);
  if (Result.isError(missingActor)) {
    expect(missingActor.error.message).toBe("--actor is required.");
  }

  const missingReason = parseReplayProviderEventsArguments([
    "--event-id",
    "event-a",
    "--results",
    resultPath,
    "--actor",
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
    "--actor",
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
    "--actor",
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
      "--actor",
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
      "--actor",
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
  try {
    const report = await runReplayReport({
      ids: ["event-ok", "event-error", "event-throw"],
      mode: "apply",
      resultsPath,
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
          throw new Error("private database detail");
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
    });

    expect(report.status).toBe("failed");
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
      replayEvent: async () => {
        throw new Error("must not run");
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
      replayEvent: async () => {
        replayed = true;
        return { type: "error", error: { message: "not relevant" } };
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
