import { panic } from "better-result";

import { decideStart } from "@stll/db-load-gate/health";
import type { Verdict } from "@stll/db-load-gate/health";

import { createDatabaseLoadVerdictReader } from "@/api/db/backfill-runtime";
import { reconcileDecisionIdentifiersStep } from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import {
  type CaseLawRootHandle,
  caseLawRootHandleUnderCorpusSchemaLane,
} from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { SCHEDULER_BACKFILL_CONFIG } from "@/api/lib/scheduler/backfill-config";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_CASE_LAW_DECISION_IDENTIFIERS_TASK =
  "caseLaw.reconcileDecisionIdentifiers" as const;

export const DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN = 4;
const DECISION_IDENTIFIER_RECONCILIATION_TIME_BUDGET_MS = 45_000;

const readDecisionTableVerdict = async (
  db: CaseLawRootHandle,
): Promise<Verdict> =>
  await createDatabaseLoadVerdictReader({
    db: {
      transaction: async (work) => await withAggregateTransaction(db, work),
    },
    tableName: "case_law_decisions",
    config: SCHEDULER_BACKFILL_CONFIG,
  })();

type ReconcileTaskOptions = {
  readVerdict?: (db: CaseLawRootHandle) => Promise<Verdict>;
  step?: typeof reconcileDecisionIdentifiersStep;
};

/**
 * Pages of the perpetual identifier pass, each admitted by the same database
 * health verdict as the other scheduler backfills: a held verdict ends the run
 * and the next minute asks again.
 */
export const createReconcileCaseLawDecisionIdentifiersTask =
  ({
    readVerdict = readDecisionTableVerdict,
    step = reconcileDecisionIdentifiersStep,
  }: ReconcileTaskOptions = {}): SchedulerTask =>
  async ({ db, logger, signal }) => {
    const laneDb = caseLawRootHandleUnderCorpusSchemaLane(db, {
      signal,
      laneWaitMs: DECISION_IDENTIFIER_RECONCILIATION_TIME_BUDGET_MS,
    });
    const startedAt = performance.now();
    for (
      let page = 0;
      page < DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN &&
      performance.now() - startedAt <
        DECISION_IDENTIFIER_RECONCILIATION_TIME_BUDGET_MS;
      page += 1
    ) {
      signal.throwIfAborted();
      // db-await-in-loop: each bounded page needs a fresh admission verdict
      const verdict = await readVerdict(laneDb);
      if (
        decideStart(verdict, "backfill_batch", SCHEDULER_BACKFILL_CONFIG)
          .decision === "wait"
      ) {
        logger.info("case_law.decision_identifier_reconciliation.held", {
          verdict: verdict.kind,
        });
        return;
      }
      // db-await-in-loop: one ordered checkpoint page per admitted verdict
      const result = await step(laneDb);
      switch (result.status) {
        case "advanced":
          if (result.repairs !== undefined) {
            logger.info("case_law.decision_identifier_reconciliation.repairs", {
              count: result.repairs.count,
              courts: result.repairs.courts,
              omittedCourts: result.repairs.omittedCourts,
            });
          }
          break;
        case "retry":
          logger.warn("case_law.decision_identifier_reconciliation.retry", {
            attempt: result.attempt,
          });
          return;
        case "retry-paused":
          logger.error("case_law.decision_identifier_reconciliation.paused", {
            attempt: result.attempt,
            retryAfter: result.retryAfter,
          });
          return;
        case "paused":
          logger.warn("case_law.decision_identifier_reconciliation.paused", {
            retryAfter: result.retryAfter,
          });
          return;
        case "cooldown":
        case "completed":
          return;
        default:
          result satisfies never;
          panic("Unhandled decision identifier reconciliation result");
      }
    }
  };

export const reconcileCaseLawDecisionIdentifiersTask =
  createReconcileCaseLawDecisionIdentifiersTask();
