import type { Transaction } from "@/api/db/root";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import type { AggregateIdentities } from "@/api/lib/db/aggregate-lock-entries/identities.gen";
import { flowScheduleJobId } from "@/api/lib/scheduler/flow-schedule-identity";
import { removeSchedulerJob } from "@/api/lib/scheduler/remove-scheduler-job";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type FlowScheduleTransactionOptions = {
  database: Pick<SchedulerDb, "transaction">;
  definitionId: AggregateIdentities["definition"]["id"];
};

export const withFlowScheduleTransaction = async (
  { database, definitionId }: FlowScheduleTransactionOptions,
  run: (tx: Transaction, jobId: string) => Promise<void>,
): Promise<void> => {
  await withAggregateTransaction(database, async (tx) => {
    const jobId = flowScheduleJobId(definitionId);
    // Lock the persistent identity first: the scheduler row may not exist yet.
    await withAggregateLock({
      tx,
      aggregate: "definitionCap",
      id: { definitionId },
    });
    await withAggregateLock({
      tx,
      aggregate: "schedulerClaim",
      id: { id: jobId },
      mode: "update",
    });
    await run(tx, jobId);
  });
};

/** Recheck under the same fence: a definition may have reappeared since the task read it. */
export const removeOrphanedFlowSchedule = async (
  options: FlowScheduleTransactionOptions,
): Promise<void> => {
  await withFlowScheduleTransaction(options, async (tx, jobId) => {
    const definition = await tx.query.flowDefinitions.findFirst({
      where: { id: { eq: options.definitionId } },
      columns: { id: true },
    });
    if (definition) {
      return;
    }
    await removeSchedulerJob(jobId, tx);
  });
};
