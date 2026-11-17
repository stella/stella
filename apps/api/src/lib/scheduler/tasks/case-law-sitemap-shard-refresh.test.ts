import { panic } from "better-result";
import { expect, test } from "bun:test";

import { CorpusSchemaLaneUnavailableError } from "@/api/db/corpus-schema-lane";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { refreshCaseLawSitemapShardsTask } from "./case-law-sitemap-shard-refresh";

const DATABASE_NOW_MS = Date.UTC(2026, 0, 1);

/** A run whose every refresh transaction fails with `failure`. */
const runFailingWith = async (failure: Error) => {
  const continuations: Date[] = [];
  const result = await refreshCaseLawSitemapShardsTask(
    asTestRaw({
      db: {
        transaction: async () => await Promise.reject(failure),
        execute: async () => [{ epoch_ms: DATABASE_NOW_MS }],
      },
      dueAt: DueSlot.of({
        nextRunAt: new Date("2000-01-01"),
        lockedAt: new Date("2000-01-01"),
      }),
      logger,
      runId: createSafeId<"schedulerJobRun">(),
      scheduleContinuation: (at: Date) => {
        continuations.push(at);
      },
      signal: new AbortController().signal,
    }),
  );
  return { continuations, result };
};

test("a refresh refused the corpus schema lane continues after the lock retry delay", async () => {
  const { continuations, result } = await runFailingWith(
    new CorpusSchemaLaneUnavailableError({
      message: "The corpus schema lane stayed unavailable",
      waitedMs: 5000,
    }),
  );
  expect(result).toBeUndefined();
  expect(continuations.map((at) => at.getTime())).toEqual([
    DATABASE_NOW_MS + 60_000,
  ]);
});

test("any other refresh failure fails the run", async () => {
  const failure = new Error("connection reset");
  const { continuations, result } = await runFailingWith(failure);
  expect(continuations).toEqual([]);
  if (result === undefined || result.isOk()) {
    panic("Expected the refresh run to fail");
  }
  expect(result.error).toBeInstanceOf(SchedulerTaskFailure);
  expect(result.error.cause).toBe(failure);
});
