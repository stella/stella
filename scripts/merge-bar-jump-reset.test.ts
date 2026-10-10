import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyJumpReset,
  createJumpResetStore,
  JUMP_RESET_WINDOW_MS,
} from "./merge-bar-jump-reset";

const at = Date.parse("2026-10-07T10:00:00Z");
const jump = {
  repo: "stella/stella",
  pr: 123,
  head: "a".repeat(40),
  at: new Date(at).toISOString(),
};
const evidence = {
  type: "complete",
  jobs: [
    { conclusion: "cancelled", completedAt: new Date(at + 1000).toISOString() },
  ],
  cancellationReason: null,
} as const;
type ClassificationOptions = Parameters<typeof classifyJumpReset>[0];
const classify = (changes: Partial<ClassificationOptions> = {}) =>
  classifyJumpReset({ repo: jump.repo, evidence, jumps: [jump], ...changes });

describe("classifying merge queue cancellations", () => {
  test.each([0, 1, JUMP_RESET_WINDOW_MS])(
    "accepts causal cancellation at offset %i",
    (offset) => {
      expect(
        classify({
          evidence: {
            ...evidence,
            jobs: [
              {
                conclusion: "cancelled",
                completedAt: new Date(at + offset).toISOString(),
              },
              { conclusion: "skipped", completedAt: null },
            ],
          },
        }),
      ).toEqual({ type: "JUMP_RESET", cause: "jump-record", jump });
    },
  );

  test("accepts jobs that succeeded before the jump beside causally cancelled ones", () => {
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            {
              conclusion: "success",
              completedAt: new Date(at - 60_000).toISOString(),
            },
            { conclusion: "skipped", completedAt: null },
            ...evidence.jobs,
          ],
        },
      }),
    ).toEqual({ type: "JUMP_RESET", cause: "jump-record", jump });
  });

  test("fail-fast: a failed step in a cancelled job rules a reset out", () => {
    // The failing job ends cancelled like its siblings; only the summary
    // job concludes failure. The failed step is the evidence.
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            { ...evidence.jobs[0], name: "e2e (1)", failedStep: true },
            ...evidence.jobs,
            {
              name: "ci-result",
              conclusion: "failure",
              completedAt: jump.at,
              // The summary job fails through a failing step, as the reader
              // reports it.
              failedStep: true,
            },
          ],
        },
      }),
    ).toEqual({ type: "not-reset" });
  });

  test("a jump: every job cancelled and the summary job failing is a reset", () => {
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            ...evidence.jobs,
            {
              name: "ci-result",
              conclusion: "failure",
              completedAt: jump.at,
              // The summary job fails through a failing step, as the reader
              // reports it.
              failedStep: true,
            },
          ],
        },
      }),
    ).toEqual({ type: "JUMP_RESET", cause: "jump-record", jump });
  });

  test("a force-cancel without a summary job is a reset only inside a jump window", () => {
    expect(classify({})).toEqual({
      type: "JUMP_RESET",
      cause: "jump-record",
      jump,
    });
    expect(classify({ jumps: [] })).toEqual({ type: "not-reset" });
  });

  test("a cancelled summary job counts as the cancellation when every other job succeeded", () => {
    const succeeded = {
      conclusion: "success",
      completedAt: new Date(at - 60_000).toISOString(),
    };
    const summary = {
      name: "ci-result",
      conclusion: "cancelled",
      completedAt: new Date(at + 1000).toISOString(),
    };
    expect(
      classify({ evidence: { ...evidence, jobs: [succeeded, summary] } }),
    ).toEqual({ type: "JUMP_RESET", cause: "jump-record", jump });
    expect(
      classify({
        evidence: { ...evidence, jobs: [succeeded, summary] },
        jumps: [],
      }),
    ).toEqual({ type: "not-reset" });
  });

  test.each(["timed_out", null])(
    "a summary job that concluded %s still rules a reset out",
    (conclusion) => {
      expect(
        classify({
          evidence: {
            ...evidence,
            jobs: [
              ...evidence.jobs,
              { name: "ci-result", conclusion, completedAt: jump.at },
            ],
          },
        }),
      ).toEqual({ type: "not-reset" });
    },
  );

  test("a group without a cancelled job is not a reset", () => {
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            { conclusion: "success", completedAt: jump.at },
            { conclusion: "skipped", completedAt: null },
          ],
        },
      }),
    ).toEqual({ type: "not-reset" });
  });

  test("a failed job still rules a reset out beside successful and cancelled jobs", () => {
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            { conclusion: "success", completedAt: jump.at },
            { conclusion: "failure", completedAt: jump.at },
            ...evidence.jobs,
          ],
        },
      }),
    ).toEqual({ type: "not-reset" });
  });

  test.each(["failure", "timed_out", "neutral", "action_required", null])(
    "refuses reset when any job concludes %s",
    (conclusion) => {
      expect(
        classify({
          evidence: {
            ...evidence,
            jobs: [...evidence.jobs, { conclusion, completedAt: jump.at }],
          },
        }),
      ).toEqual({ type: "not-reset" });
    },
  );

  test.each([-1, JUMP_RESET_WINDOW_MS + 1])(
    "refuses cancellation outside the causal window: %i",
    (offset) => {
      expect(
        classify({
          evidence: {
            ...evidence,
            jobs: [
              {
                conclusion: "cancelled",
                completedAt: new Date(at + offset).toISOString(),
              },
            ],
          },
        }),
      ).toEqual({ type: "not-reset" });
    },
  );

  test("requires matching repository correlation", () => {
    expect(classify({ jumps: [] })).toEqual({ type: "not-reset" });
    expect(classify({ jumps: [{ ...jump, repo: "stella/folio" }] })).toEqual({
      type: "not-reset",
    });
  });

  test("every cancellation must correlate with the same accepted jump", () => {
    expect(
      classify({
        evidence: {
          ...evidence,
          jobs: [
            ...evidence.jobs,
            {
              conclusion: "cancelled",
              completedAt: new Date(
                at + JUMP_RESET_WINDOW_MS + 1,
              ).toISOString(),
            },
          ],
        },
      }),
    ).toEqual({ type: "not-reset" });
    const recent = { ...jump, at: new Date(at + 500).toISOString() };
    expect(classify({ jumps: [jump, recent] })).toEqual({
      type: "JUMP_RESET",
      cause: "jump-record",
      jump: recent,
    });
    expect(classify({ jumps: [{ ...jump, at: "invalid" }] })).toEqual({
      type: "not-reset",
    });
  });

  test("explicit higher priority cancellation still requires cancelled job evidence", () => {
    const priority = {
      ...evidence,
      cancellationReason:
        "Canceling since a higher priority waiting request for 'merge queue' exists",
    };
    expect(classify({ evidence: priority, jumps: [] })).toEqual({
      type: "JUMP_RESET",
      cause: "priority-reason",
    });
    expect(
      classify({
        evidence: {
          ...priority,
          jobs: [
            ...evidence.jobs,
            { conclusion: "failure", completedAt: jump.at },
          ],
        },
        jumps: [],
      }),
    ).toEqual({ type: "not-reset" });
    expect(
      classify({
        evidence: { ...evidence, cancellationReason: "Cancelled manually" },
        jumps: [],
      }),
    ).toEqual({ type: "not-reset" });
  });

  test("missing and incomplete evidence never authorizes a reset", () => {
    expect(classify({ evidence: { type: "unavailable" } })).toEqual({
      type: "not-reset",
    });
    for (const jobs of [
      [],
      [{ conclusion: "skipped", completedAt: null }],
      [{ conclusion: "cancelled", completedAt: null }],
      [{ conclusion: "cancelled", completedAt: "invalid" }],
    ]) {
      expect(classify({ evidence: { ...evidence, jobs } })).toEqual({
        type: "not-reset",
      });
    }
  });
});

describe("durable jump records and per-head reset reservations", () => {
  test("record replay survives new store instances without duplicating jumps", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-record-"));
    try {
      const store = createJumpResetStore(directory);
      expect(store.recordJump(jump).isOk()).toBe(true);
      expect(store.recordJump(jump).isOk()).toBe(true);
      const result = createJumpResetStore(directory).readJumps();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([jump]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reservation persists across restart and separates heads and repositories", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-reservation-"));
    try {
      const key = `${jump.repo}#${jump.pr}@${jump.head}`;
      const first = createJumpResetStore(directory);
      expect(first.reserve(key).isOk()).toBe(true);
      const restarted = createJumpResetStore(directory);
      const recorded = restarted.hasReservation(key);
      expect(recorded.isOk()).toBe(true);
      if (recorded.isOk()) {
        expect(recorded.value).toBe(true);
      }
      expect(restarted.reserve(key).isErr()).toBe(true);
      expect(
        restarted.reserve(`${jump.repo}#${jump.pr}@${"b".repeat(40)}`).isOk(),
      ).toBe(true);
      expect(
        restarted.reserve(`stella/folio#${jump.pr}@${jump.head}`).isOk(),
      ).toBe(true);
      const jumps = restarted.readJumps();
      expect(jumps.isOk()).toBe(true);
      if (jumps.isOk()) {
        expect(jumps.value).toEqual([]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("records publish without leftovers and an interrupted write is never read as a record", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-publish-"));
    try {
      const store = createJumpResetStore(directory);
      expect(store.recordJump(jump).isOk()).toBe(true);
      expect(store.reserve(`${jump.repo}#${jump.pr}@${jump.head}`).isOk()).toBe(
        true,
      );
      for (const kind of ["jumps", "rearms"]) {
        expect(
          readdirSync(path.join(directory, kind)).filter((name) =>
            name.endsWith(".tmp"),
          ),
        ).toEqual([]);
      }
      // What a crash between the write and the publish leaves behind.
      writeFileSync(
        path.join(directory, "jumps", "interrupted.json.0f.tmp"),
        '{"repo":"stella/st',
      );
      const result = createJumpResetStore(directory).readJumps();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([jump]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("corrupt accepted records fail closed", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-corruption-"));
    try {
      const store = createJumpResetStore(directory);
      expect(store.recordJump(jump).isOk()).toBe(true);
      const records = path.join(directory, "jumps");
      const filename = readdirSync(records).at(0);
      expect(filename).toBeDefined();
      if (filename === undefined) {
        return;
      }
      writeFileSync(path.join(records, filename), "{broken");
      expect(createJumpResetStore(directory).readJumps().isErr()).toBe(true);
      writeFileSync(
        path.join(records, filename),
        JSON.stringify({ ...jump, head: "invalid" }),
      );
      expect(createJumpResetStore(directory).readJumps().isErr()).toBe(true);
      expect(store.recordJump(jump).isErr()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an interrupted reservation remains blocking without an accepted record", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-interrupted-"));
    try {
      const key = `${jump.repo}#${jump.pr}@${jump.head}`;
      const store = createJumpResetStore(directory);
      expect(store.reserve(key).isOk()).toBe(true);
      const reservations = path.join(directory, "rearms");
      const filename = readdirSync(reservations).at(0);
      expect(filename).toBeDefined();
      if (filename === undefined) {
        return;
      }
      writeFileSync(path.join(reservations, filename), "");
      const restarted = createJumpResetStore(directory);
      const reserved = restarted.hasReservation(key);
      expect(reserved.isOk()).toBe(true);
      if (reserved.isOk()) {
        expect(reserved.value).toBe(true);
      }
      expect(restarted.reserve(key).isErr()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
