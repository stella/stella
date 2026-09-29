import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import {
  withDedicatedReservedSession,
  withLongRunningConnection,
} from "@/api/db/long-running-connection";
import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ProvisionBackfillSession } from "@/api/lib/case-law/provision-state-backfill/step";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_CASE_LAW_PROVISION_STATE_TASK =
  "caseLaw.backfillProvisionState" as const;

/**
 * Wall time one run may spend starting keyset pages. A page commits in well
 * under a second, so a run ends shortly after this; the next run resumes from
 * the committed cursors. A CHECK validation scan runs alone in its run under
 * its own statement budget.
 */
const RUN_BUDGET_MS = 5 * 60_000;
const VALIDATE_STATEMENT_TIMEOUT_MS = 25 * 60_000;
const CONNECTION_LOCK_TIMEOUT_MS = 30_000;

const backfillUnitFailed = failureSink({
  event: "scheduler.case_law_provision_state_backfill_failed",
  expected: [],
});

/** The part of a reserved Bun SQL connection the backfill uses. */
type ReservedConnection = {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
  release: () => void;
  close: () => Promise<void>;
};

type ReservedSessionOptions<T> = {
  reserve: () => Promise<ReservedConnection>;
  /** Cancels whatever the given backend is running, from another connection. */
  cancelBackend: (pid: number) => Promise<unknown>;
  signal: AbortSignal;
  work: (session: ProvisionBackfillSession) => Promise<T>;
};

const readRows = (result: unknown): readonly unknown[] =>
  Array.isArray(result) ? result : panic("Bun SQL returned a non-array result");

/**
 * Runs `work` on one reserved connection and gives the connection back on
 * every path. An abort cancels the statement in flight: Bun's own
 * `cancel()` stops only a query that has not started, so the cancel goes to
 * the backend from another connection. Such a cancel can land after the
 * statement it was meant for, so an aborted connection is closed rather
 * than returned to the pool, once the cancel has settled: no later user of
 * the pool can receive it.
 */
export const withReservedSession = async <T>({
  reserve,
  cancelBackend,
  signal,
  work,
}: ReservedSessionOptions<T>): Promise<T> =>
  await withDedicatedReservedSession({
    reserve,
    cancelBackend,
    signal,
    work: async (reserved, setTransactionBudget) =>
      await work({
        setTransactionBudget,
        execute: async (query, params = []) => {
          await reserved.unsafe(query, [...params]);
        },
        query: async (query, params = []) =>
          readRows(await reserved.unsafe(query, [...params])),
      }),
  });

/**
 * The provision state backfill: scope rows for every decision key, the
 * profiles' scopes and their transition jobs, state for every in-scope
 * decision, then the provision-row CHECK validations. It runs here rather
 * than in the migrate phase because that phase holds the corpus schema lane
 * exclusively and would pause every corpus writer for the whole walk.
 *
 * Recurring: a finished backfill costs a handful of reads per run, and a
 * profile that gains or loses a scope in a later release is applied by the
 * next run.
 */
export const createCaseLawProvisionStateBackfillTask =
  ({
    withConnection = withLongRunningConnection,
  }: {
    withConnection?: typeof withLongRunningConnection;
  } = {}): SchedulerTask =>
  async ({ logger, signal }) => {
    signal.throwIfAborted();
    // The connection helper rejects once the signal aborts, even after the work
    // has returned, so an abort is settled here rather than left to reject.
    const settled = await Result.tryPromise({
      try: async () =>
        await withConnection(
          {
            lockTimeout: CONNECTION_LOCK_TIMEOUT_MS,
            statementTimeout: VALIDATE_STATEMENT_TIMEOUT_MS,
            signal,
          },
          async ({ connection, setTransactionBudget }) =>
            await runProvisionStateBackfill({
              connection: {
                setTransactionBudget,
                execute: async (query, params = []) => {
                  await connection.unsafe(query, [...params]);
                },
                query: async (query, params = []) =>
                  readRows(await connection.unsafe(query, [...params])),
              },
              deadline:
                Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS,
              signal,
            }),
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(settled)) {
      if (signal.aborted) {
        logger.info("scheduler.case_law_provision_state_backfill_aborted", {});
        return;
      }
      observeFailure(settled.error, { sink: backfillUnitFailed });
      return;
    }
    const run = settled.value;
    if (run.isErr()) {
      // A cancelled statement is the abort itself, not a failure; either way
      // the unit rolled back and the next run retries it from its cursor.
      if (signal.aborted) {
        logger.info("scheduler.case_law_provision_state_backfill_aborted", {});
        return;
      }
      observeFailure(run.error, { sink: backfillUnitFailed });
      return;
    }
    logger.info("scheduler.case_law_provision_state_backfill", {
      // The step still owed, "complete", "aborted", or "superseded" when a
      // newer release has applied its admission.
      "caseLawProvisionStateBackfill.pending":
        run.value.type === "progress" || run.value.type === "aborted"
          ? run.value.step
          : run.value.type,
    });
  };

export const backfillCaseLawProvisionState: SchedulerTask =
  createCaseLawProvisionStateBackfillTask();
