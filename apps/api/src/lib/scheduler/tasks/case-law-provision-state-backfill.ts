import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { detached } from "@/api/lib/analytics/capture";
import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ProvisionBackfillSession } from "@/api/lib/case-law/provision-state-backfill/step";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { isRecord } from "@/api/lib/type-guards";

export const BACKFILL_CASE_LAW_PROVISION_STATE_TASK =
  "caseLaw.backfillProvisionState" as const;

/**
 * Wall time one run may spend starting keyset pages. A page commits in well
 * under a second, so a run ends shortly after this; the next run resumes from
 * the committed cursors. A CHECK validation scan runs alone in its run under
 * its own statement budget.
 */
const RUN_BUDGET_MS = 5 * 60_000;

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
}: ReservedSessionOptions<T>): Promise<T> => {
  const reserved = await reserve();
  let cancelling: Promise<unknown> | undefined;
  let cancelInFlight: (() => void) | undefined;
  const body = (async () => {
    const pid = readRows(
      await reserved.unsafe("SELECT pg_backend_pid() AS pid"),
    ).find(isRecord)?.["pid"];
    if (typeof pid !== "number") {
      return panic("Expected the reserved session's PostgreSQL backend pid");
    }
    cancelInFlight = () => {
      cancelling = cancelBackend(pid);
      detached(cancelling, "provision-state-backfill.cancel-statement");
    };
    signal.addEventListener("abort", cancelInFlight, { once: true });
    return await work({
      execute: async (query, params = []) => {
        await reserved.unsafe(query, [...params]);
      },
      query: async (query, params = []) =>
        readRows(await reserved.unsafe(query, [...params])),
    });
  })();
  // The connection goes back however the body ends; its outcome, value or
  // rejection, is returned only after that.
  await Promise.allSettled([body]);
  if (cancelInFlight !== undefined) {
    signal.removeEventListener("abort", cancelInFlight);
  }
  if (cancelling === undefined) {
    reserved.release();
  } else {
    await Promise.allSettled([cancelling]);
    await reserved.close();
  }
  return await body;
};

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
export const backfillCaseLawProvisionState: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const run = await withReservedSession({
    reserve: async () => await db.$client.reserve(),
    cancelBackend: async (pid) =>
      await db.execute(sql`SELECT pg_cancel_backend(${pid})`),
    signal,
    work: async (connection) =>
      await runProvisionStateBackfill({
        connection,
        deadline: Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS,
        signal,
      }),
  });
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
