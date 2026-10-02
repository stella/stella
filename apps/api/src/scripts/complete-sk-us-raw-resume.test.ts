import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/handlers/case-law/ingestion/adapter";
import { createSafeId } from "@/api/lib/branded-types";
import {
  journalSkUsRawOutcome,
  readSkUsRawCheckpoint,
  persistSkUsRawCheckpoint,
} from "@/api/scripts/complete-sk-us-raw-checkpoint";
import {
  SK_US_RAW_OUTCOMES,
  SK_US_RAW_OUTCOME_DISPOSITIONS,
  runSkUsRawBatch,
} from "@/api/scripts/complete-sk-us-raw-plan";

const NOT_REJECTED = Symbol("not rejected");

/**
 * bun-types declares `.rejects` matchers as void, so the rejection is captured
 * and asserted directly: its class, or a message substring or pattern.
 */
const expectRejection = async (
  pending: Promise<unknown>,
  expected: string | RegExp | (new (...args: never[]) => Error),
) => {
  const thrown = await pending.then(
    () => NOT_REJECTED,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Error);
  if (typeof expected === "function") {
    expect(thrown).toBeInstanceOf(expected);
    return;
  }
  expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(
    expected,
  );
};

/** A fixture row that must exist; a missing one fails loudly, never as `undefined`. */
const rowAt = <T>(items: readonly T[], index: number): T => {
  const item = items.at(index);
  if (item === undefined) {
    throw new TypeError(`fixture row ${index} is missing`);
  }
  return item;
};

const journalSchema = v.array(
  v.object({
    version: v.literal(1),
    sourceId: v.pipe(v.string(), v.uuid()),
    cursor: v.object({
      id: v.pipe(v.string(), v.uuid()),
      createdAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    outcome: v.picklist(SK_US_RAW_OUTCOMES),
    disposition: v.picklist(["terminal", "retryable", "preview"]),
  }),
);
const readJournal = async (checkpointPath: string) =>
  v.parse(
    journalSchema,
    (await readFile(`${checkpointPath}.outcomes.jsonl`, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );

test("killing a multi-page batch resumes its durable checkpoint without duplicate effects or skipped rows", async () => {
  for (const pauseAt of [
    "before_write",
    "after_write",
    "after_checkpoint",
    "after_journal",
  ] as const) {
    for (const pageSize of [1, 2, 20]) {
      const directory = await mkdtemp(path.join(tmpdir(), "sk-us-resume-"));
      const sourceId = createSafeId<"caseLawSource">();
      const rows = Array.from({ length: 5 }, (_, index) => ({
        id: createSafeId<"caseLawDecision">(),
        createdAt: `2026-03-01T00:00:00.00000${index + 1}Z`,
      }));
      const pauseRow = rows.at(2);
      if (pauseRow === undefined) {
        expect.unreachable("middle row must exist");
      }
      const checkpointPath = path.join(directory, "checkpoint.json");
      const config = {
        directory,
        sourceId,
        rows,
        pageSize,
        pauseAt,
        pauseId: pauseRow.id,
      };
      const spawnWorker = (pause: typeof config.pauseAt | "none") =>
        Bun.spawn({
          cmd: [
            process.execPath,
            "run",
            path.join(
              import.meta.dir,
              "__fixtures__/sk-us-raw-resume-worker.ts",
            ),
            JSON.stringify({ ...config, pauseAt: pause }),
          ],
          cwd: path.resolve(import.meta.dir, "../.."),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      let killed: ReturnType<typeof spawnWorker> | undefined;
      let resumed: ReturnType<typeof spawnWorker> | undefined;
      let rerun: ReturnType<typeof spawnWorker> | undefined;
      try {
        for (const row of rows) {
          await writeFile(
            path.join(directory, `${row.id}.json`),
            JSON.stringify({
              raw: encodeSourceRawEnvelope({ document: `text-${row.id}` }),
              writes: 0,
            }),
          );
        }
        killed = spawnWorker(pauseAt);
        const reader = killed.stdout.getReader();
        let output = "";
        while (!output.includes("paused\n")) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new TypeError(
              `worker exited before kill boundary: ${output}\n${await new Response(killed.stderr).text()}`,
            );
          }
          output += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        killed.kill("SIGKILL");
        expect(await killed.exited).not.toBe(0);
        const beforeResume = await readSkUsRawCheckpoint({
          checkpointPath,
          sourceId,
        });
        expect(beforeResume).toEqual(
          rowAt(rows, pauseAt === "after_checkpoint" ? 2 : 1),
        );
        expect(
          (await readJournal(checkpointPath)).map(({ cursor }) => cursor.id),
        ).toEqual(
          rows
            .slice(
              0,
              pauseAt === "after_checkpoint" || pauseAt === "after_journal"
                ? 3
                : 2,
            )
            .map(({ id }) => id),
        );
        resumed = spawnWorker("none");
        const errors = new Response(resumed.stderr).text();
        const result = new Response(resumed.stdout).text();
        expect(await resumed.exited).toBe(0);
        expect(await errors).toBe("");
        const summary = v.parse(
          v.object({ stopped: v.boolean(), scanned: v.number() }),
          JSON.parse((await result).trim()),
        );
        expect(summary.stopped).toBe(false);
        expect(summary.scanned).toBe(pauseAt === "after_checkpoint" ? 2 : 3);
        expect(
          await readSkUsRawCheckpoint({ checkpointPath, sourceId }),
        ).toEqual(rowAt(rows, -1));
        const journal = await readJournal(checkpointPath);
        const expectedJournalRows =
          pauseAt === "after_journal"
            ? [...rows.slice(0, 3), ...rows.slice(2)]
            : rows;
        expect(journal.map(({ cursor }) => cursor.id)).toEqual(
          expectedJournalRows.map(({ id }) => id),
        );
        expect(new Set(journal.map(({ cursor }) => cursor.id))).toEqual(
          new Set(rows.map(({ id }) => id)),
        );
        expect(journal.length - rows.length).toBe(
          pauseAt === "after_journal" ? 1 : 0,
        );
        expect(
          journal.every(({ disposition }) => disposition === "terminal"),
        ).toBe(true);
        expect(journal.map(({ outcome }) => outcome)).toEqual(
          expectedJournalRows.map(({ id }, index) =>
            id === pauseRow.id &&
            (pauseAt === "after_write" ||
              (pauseAt === "after_journal" && index === 3))
              ? "already_complete"
              : "completed",
          ),
        );
        const fetches = v.parse(
          v.array(v.string()),
          (await readFile(path.join(directory, "fetches.jsonl"), "utf-8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
        expect(fetches).toEqual(
          pauseAt === "before_write"
            ? [
                ...rows.slice(0, 3).map(({ id }) => id),
                ...rows.slice(2).map(({ id }) => id),
              ]
            : rows.map(({ id }) => id),
        );
        rerun = spawnWorker("none");
        const rerunErrors = new Response(rerun.stderr).text();
        const rerunOutput = new Response(rerun.stdout).text();
        expect(await rerun.exited).toBe(0);
        expect(await rerunErrors).toBe("");
        expect(
          v.parse(
            v.object({ scanned: v.number() }),
            JSON.parse((await rerunOutput).trim()),
          ).scanned,
        ).toBe(0);
        expect(await readJournal(checkpointPath)).toEqual(journal);
        expect(
          v.parse(
            v.array(v.string()),
            (await readFile(path.join(directory, "fetches.jsonl"), "utf-8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ),
        ).toEqual(fetches);
        for (const row of rows) {
          const stored = v.parse(
            v.object({ raw: v.string(), writes: v.number() }),
            JSON.parse(
              await readFile(path.join(directory, `${row.id}.json`), "utf-8"),
            ),
          );
          expect(stored.writes).toBe(1);
          expect(decodeSourceRawEnvelope(stored.raw)).toEqual({
            document: `text-${row.id}`,
            listing: JSON.stringify({ documentId: row.id }),
          });
        }
      } finally {
        if (killed !== undefined) {
          killed.kill();
          await killed.exited;
        }
        if (resumed !== undefined) {
          resumed.kill();
          await resumed.exited;
        }
        if (rerun !== undefined) {
          rerun.kill();
          await rerun.exited;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 30_000);

test("checkpoint reload accepts terminal records and rejects ambiguous or foreign progress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sk-us-checkpoint-"));
  const sourceId = createSafeId<"caseLawSource">();
  const cursor = {
    id: createSafeId<"caseLawDecision">(),
    createdAt: "2026-03-01T00:00:00.000001Z",
  };
  const checkpointPath = path.join(directory, "checkpoint.json");
  const forbidden = [
    "would_complete",
    "retry_later",
    "concurrent_write",
    "publisher_rate_limited",
  ];
  try {
    expect(
      await readSkUsRawCheckpoint({ checkpointPath, sourceId }),
    ).toBeNull();
    for (const outcome of SK_US_RAW_OUTCOMES) {
      await journalSkUsRawOutcome({
        checkpointPath,
        sourceId,
        cursor,
        outcome,
      });
      if (forbidden.includes(outcome)) {
        await expectRejection(
          persistSkUsRawCheckpoint({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),

          "Checkpoint does not record a terminal applied outcome",
        );
        await writeFile(
          checkpointPath,
          JSON.stringify({ version: 1, sourceId, cursor, outcome }),
        );
        await expectRejection(
          readSkUsRawCheckpoint({ checkpointPath, sourceId }),

          "Checkpoint does not record a terminal applied outcome",
        );
      } else {
        await persistSkUsRawCheckpoint({
          checkpointPath,
          sourceId,
          cursor,
          outcome,
        });
        expect(
          await readSkUsRawCheckpoint({ checkpointPath, sourceId }),
        ).toEqual(cursor);
      }
    }
    expect(
      (await readJournal(checkpointPath)).map(({ disposition }) => disposition),
    ).toEqual(
      SK_US_RAW_OUTCOMES.map(
        (outcome) => SK_US_RAW_OUTCOME_DISPOSITIONS[outcome],
      ),
    );
    await expectRejection(
      readSkUsRawCheckpoint({
        checkpointPath,
        sourceId: createSafeId<"caseLawSource">(),
      }),
      "Checkpoint belongs to a different source",
    );
    await writeFile(checkpointPath, "{");
    await expectRejection(
      readSkUsRawCheckpoint({ checkpointPath, sourceId }),
      SyntaxError,
    );
    await expectRejection(
      readSkUsRawCheckpoint({ checkpointPath: directory, sourceId }),
      /EISDIR/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torn journal tail is dropped before the next record so every line stays parseable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sk-us-journal-tail-"));
  const sourceId = createSafeId<"caseLawSource">();
  const checkpointPath = path.join(directory, "checkpoint.json");
  const journalPath = `${checkpointPath}.outcomes.jsonl`;
  const cursorAt = (createdAt: string) => ({
    id: createSafeId<"caseLawDecision">(),
    createdAt,
  });
  const first = cursorAt("2026-03-01T00:00:00.000001Z");
  const torn = cursorAt("2026-03-01T00:00:00.000002Z");
  const retried = cursorAt("2026-03-01T00:00:00.000003Z");
  try {
    await journalSkUsRawOutcome({
      checkpointPath,
      sourceId,
      cursor: first,
      outcome: "completed",
    });
    const clean = await readFile(journalPath, "utf-8");
    // A crash after part of the next record reached the disk.
    const tornRecord = JSON.stringify({ version: 1, sourceId, cursor: torn });
    await writeFile(journalPath, `${clean}${tornRecord.slice(0, 37)}`);
    await journalSkUsRawOutcome({
      checkpointPath,
      sourceId,
      cursor: retried,
      outcome: "retry_later",
    });
    const repaired = await readFile(journalPath, "utf-8");
    expect(repaired.startsWith(clean)).toBe(true);
    expect(repaired.endsWith("\n")).toBe(true);
    expect(
      (await readJournal(checkpointPath)).map(({ cursor, outcome }) => [
        cursor.id,
        outcome,
      ]),
    ).toEqual([
      [first.id, "completed"],
      [retried.id, "retry_later"],
    ]);

    // A journal holding only a fragment keeps nothing of it.
    await writeFile(journalPath, tornRecord.slice(0, 12));
    await journalSkUsRawOutcome({
      checkpointPath,
      sourceId,
      cursor: first,
      outcome: "completed",
    });
    expect(await readFile(journalPath, "utf-8")).toBe(clean);

    // A complete journal is appended to byte for byte.
    await journalSkUsRawOutcome({
      checkpointPath,
      sourceId,
      cursor: retried,
      outcome: "retry_later",
    });
    expect(await readFile(journalPath, "utf-8")).toBe(repaired);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("torn-tail repair preserves every complete byte beyond the journal read window", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sk-us-journal-window-"));
  const sourceId = createSafeId<"caseLawSource">();
  const checkpointPath = path.join(directory, "checkpoint.json");
  const journalPath = `${checkpointPath}.outcomes.jsonl`;
  const records = Array.from(
    { length: 400 },
    () =>
      ({
        version: 1,
        sourceId,
        cursor: {
          id: createSafeId<"caseLawDecision">(),
          createdAt: "2026-03-01T00:00:00.000001Z",
        },
        outcome: "completed",
        disposition: "terminal",
      }) as const,
  );
  const prefix = records
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");
  const cursor = {
    id: createSafeId<"caseLawDecision">(),
    createdAt: "2026-03-01T00:00:00.000002Z",
  };
  const appended = {
    version: 1,
    sourceId,
    cursor,
    outcome: "retry_later",
    disposition: "retryable",
  } as const;
  // Larger than the 64 KiB tail the repair reads, so it must keep bytes it
  // never looked at.
  expect(Buffer.byteLength(prefix)).toBeGreaterThan(64 * 1024);
  try {
    for (const fragmentLength of [1, 37, 1024]) {
      const torn = `${prefix}${"x".repeat(fragmentLength)}`;
      expect(torn.endsWith("\n")).toBe(false);
      await writeFile(journalPath, torn);
      await journalSkUsRawOutcome({
        checkpointPath,
        sourceId,
        cursor,
        outcome: "retry_later",
      });
      expect(await readFile(journalPath, "utf-8")).toBe(
        `${prefix}${JSON.stringify(appended)}\n`,
      );
      expect(await readJournal(checkpointPath)).toEqual([...records, appended]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized unterminated journal tail is refused, never truncated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sk-us-journal-tail-"));
  const sourceId = createSafeId<"caseLawSource">();
  const checkpointPath = path.join(directory, "checkpoint.json");
  const journalPath = `${checkpointPath}.outcomes.jsonl`;
  const content = `{"version":1}\n${"x".repeat(64 * 1024 + 1)}`;
  try {
    await writeFile(journalPath, content);
    await expectRejection(
      journalSkUsRawOutcome({
        checkpointPath,
        sourceId,
        cursor: {
          id: createSafeId<"caseLawDecision">(),
          createdAt: "2026-03-01T00:00:00.000001Z",
        },
        outcome: "completed",
      }),

      "Outcome journal ends with an oversized unterminated record",
    );
    expect(await readFile(journalPath, "utf-8")).toBe(content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every retryable row is durably journaled before stopping without advancing its checkpoint", async () => {
  for (const retryOutcome of [
    "retry_later",
    "publisher_rate_limited",
    "concurrent_write",
  ] as const) {
    const directory = await mkdtemp(
      path.join(tmpdir(), "sk-us-retry-journal-"),
    );
    const sourceId = createSafeId<"caseLawSource">();
    const checkpointPath = path.join(directory, "checkpoint.json");
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      createdAt: `2026-03-01T00:00:00.00000${index + 1}Z`,
    }));
    const previous = rows.at(0);
    const failed = rows.at(1);
    if (previous === undefined || failed === undefined) {
      expect.unreachable("fixture needs prefix and retry row");
    }
    const visited: string[] = [];
    try {
      const result = await runSkUsRawBatch({
        rows,
        pageSize: 1,
        after: null,
        mode: "apply",
        complete: async (row) => {
          visited.push(row.id);
          return row.id === failed.id ? retryOutcome : "completed";
        },
        journal: async (cursor, outcome) =>
          await journalSkUsRawOutcome({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),
        checkpoint: async (cursor, outcome) =>
          await persistSkUsRawCheckpoint({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),
      });
      expect(result.stopped).toBe(true);
      expect(result.cursor).toEqual(previous);
      expect(result.scanned).toBe(2);
      expect(visited).toEqual([previous.id, failed.id]);
      expect(await readSkUsRawCheckpoint({ checkpointPath, sourceId })).toEqual(
        previous,
      );
      expect(await readJournal(checkpointPath)).toEqual([
        {
          version: 1,
          sourceId,
          cursor: previous,
          outcome: "completed",
          disposition: "terminal",
        },
        {
          version: 1,
          sourceId,
          cursor: failed,
          outcome: retryOutcome,
          disposition: "retryable",
        },
      ]);
      const resumedVisits: string[] = [];
      const resumed = await runSkUsRawBatch({
        rows: rows.slice(1),
        pageSize: 2,
        after: await readSkUsRawCheckpoint({ checkpointPath, sourceId }),
        mode: "apply",
        complete: async (row) => {
          resumedVisits.push(row.id);
          return "completed";
        },
        journal: async (cursor, outcome) =>
          await journalSkUsRawOutcome({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),
        checkpoint: async (cursor, outcome) =>
          await persistSkUsRawCheckpoint({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),
      });
      expect(resumed.stopped).toBe(false);
      expect(resumedVisits).toEqual(rows.slice(1).map(({ id }) => id));
      expect(await readSkUsRawCheckpoint({ checkpointPath, sourceId })).toEqual(
        rowAt(rows, -1),
      );
      const journal = await readJournal(checkpointPath);
      expect(journal).toHaveLength(4);
      expect(new Set(journal.map(({ cursor }) => cursor.id))).toEqual(
        new Set(rows.map(({ id }) => id)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("journal persistence failure prevents checkpoint advancement and later rows", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sk-us-journal-failure-"),
  );
  const sourceId = createSafeId<"caseLawSource">();
  const checkpointPath = path.join(directory, "missing", "checkpoint.json");
  const rows = Array.from({ length: 2 }, () => ({
    id: createSafeId<"caseLawDecision">(),
    createdAt: "2026-03-01T00:00:00.000001Z",
  }));
  const visited: string[] = [];
  let checkpoints = 0;
  try {
    await expectRejection(
      runSkUsRawBatch({
        rows,
        pageSize: 1,
        after: null,
        mode: "apply",
        complete: async (row) => {
          visited.push(row.id);
          return "completed";
        },
        journal: async (cursor, outcome) =>
          await journalSkUsRawOutcome({
            checkpointPath,
            sourceId,
            cursor,
            outcome,
          }),
        checkpoint: async () => {
          checkpoints += 1;
        },
      }),
      /ENOENT/u,
    );
    expect(visited).toEqual(rows.slice(0, 1).map(({ id }) => id));
    expect(checkpoints).toBe(0);
    expect(
      await readSkUsRawCheckpoint({ checkpointPath, sourceId }),
    ).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
