import { expect, mock, test } from "bun:test";

import type { Verdict, VerdictKind } from "@stll/db-load-gate/health";

import { CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL } from "@/api/db/corpus-schema-lane";
import {
  createReconcileCaseLawDecisionIdentifiersTask,
  DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN,
} from "@/api/lib/scheduler/tasks/case-law-decision-identifier-reconciliation";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const verdictOf = (kind: VerdictKind): Verdict => ({ kind, signals: [] });

const run = async (kinds: readonly VerdictKind[]) => {
  const verdicts = [...kinds];
  const step = mock(async () => ({ status: "advanced" as const }));
  const info = mock();
  await createReconcileCaseLawDecisionIdentifiersTask({
    readVerdict: async () => verdictOf(verdicts.shift() ?? "normal"),
    step,
  })(
    asTestRaw<SchedulerTaskContext>({
      db: {},
      logger: { info },
      signal: new AbortController().signal,
    }),
  );
  return { info, step };
};

test("a held database admits no page and logs the hold", async () => {
  const { info, step } = await run(["stop"]);
  expect(step).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(
    "case_law.decision_identifier_reconciliation.held",
    { verdict: "stop" },
  );
});

test("each page asks the gate again and the run ends at the first hold", async () => {
  const { step } = await run(["normal", "degraded", "unknown"]);
  // A degraded verdict still admits backfill batches; an unknown one holds.
  expect(step).toHaveBeenCalledTimes(2);
});

test("a healthy database runs the bounded page budget", async () => {
  const { step } = await run([]);
  expect(step).toHaveBeenCalledTimes(
    DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN,
  );
});

test("verification retry stops the page run and reports the durable attempt", async () => {
  const step = mock(async () => ({ status: "retry" as const, attempt: 2 }));
  const warn = mock();
  await createReconcileCaseLawDecisionIdentifiersTask({
    readVerdict: async () => verdictOf("normal"),
    step,
  })(
    asTestRaw<SchedulerTaskContext>({
      db: {},
      logger: { warn },
      signal: new AbortController().signal,
    }),
  );
  expect(step).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "case_law.decision_identifier_reconciliation.retry",
    { attempt: 2 },
  );
});

test("the retry limit emits a visible pause and stops the page run", async () => {
  const retryAfter = "2026-10-26T18:00:00.000Z";
  const step = mock(async () => ({
    status: "retry-paused" as const,
    attempt: 3,
    retryAfter,
  }));
  const error = mock();
  await createReconcileCaseLawDecisionIdentifiersTask({
    readVerdict: async () => verdictOf("normal"),
    step,
  })(
    asTestRaw<SchedulerTaskContext>({
      db: {},
      logger: { error },
      signal: new AbortController().signal,
    }),
  );
  expect(step).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    "case_law.decision_identifier_reconciliation.paused",
    { attempt: 3, retryAfter },
  );
});

test("verdict and page work each acquire the corpus schema lane", async () => {
  const observed: string[] = [];
  let active = false;
  const tx = {
    execute: async (statement: unknown) => {
      if (statement === CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL) {
        observed.push("lane");
        return [{ granted: true }];
      }
      observed.push(String(statement));
      return [];
    },
  };
  const db = {
    transaction: async <T>(work: (handle: typeof tx) => Promise<T>) => {
      expect(active).toBe(false);
      active = true;
      try {
        return await work(tx);
      } finally {
        active = false;
      }
    },
  };
  await createReconcileCaseLawDecisionIdentifiersTask({
    readVerdict: async (laneDb) => {
      await laneDb.execute("verdict");
      return verdictOf("normal");
    },
    step: async (laneDb) =>
      await laneDb.transaction(async (handle) => {
        await handle.execute("page");
        return { status: "completed" as const };
      }),
  })(
    asTestRaw<SchedulerTaskContext>({
      db,
      logger: {},
      signal: new AbortController().signal,
    }),
  );
  expect(observed).toEqual(["lane", "verdict", "lane", "page"]);
});
