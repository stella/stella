import { flowDefinitions } from "@/api/db/schema";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import type { AggregateIdentities } from "@/api/lib/db/aggregate-lock-entries/identities.gen";
import { flowScheduleToSchedulerSchedule } from "@/api/lib/flows/flow-trigger-logic";
import { FLOW_RUN_TASK } from "@/api/lib/scheduler/flow-schedule-identity";
import { withFlowScheduleTransaction } from "@/api/lib/scheduler/flow-schedule-transaction";
import type { upsertSchedulerJob } from "@/api/lib/scheduler/jobs";
import { removeSchedulerJob } from "@/api/lib/scheduler/remove-scheduler-job";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type ReconcileFlowScheduleDependencies = {
  database: Pick<SchedulerDb, "transaction">;
  upsert: typeof upsertSchedulerJob;
};

/** Reconcile committed state; callers never lend a possibly retired definition snapshot. */
export const reconcileFlowSchedule = async (
  identity: AggregateIdentities["definition"],
  { database, upsert }: ReconcileFlowScheduleDependencies,
): Promise<void> => {
  await withFlowScheduleTransaction(
    { database, definitionId: identity.id },
    async (tx, jobId) => {
      const acquisition = await withAggregateRowQuery({
        tx,
        aggregate: "definition",
        id: identity,
        mode: "update",
        select: (readTx) =>
          readTx
            .select({
              id: flowDefinitions.id,
              organizationId: flowDefinitions.organizationId,
              trigger: flowDefinitions.trigger,
              enabled: flowDefinitions.enabled,
            })
            .from(flowDefinitions),
      });
      const definition = acquisition.rows.at(0);
      if (!definition) {
        // A retired organization must not remove the same ID's current owner's job.
        const current = await tx.query.flowDefinitions.findFirst({
          where: { id: { eq: identity.id } },
          columns: { id: true },
        });
        if (current) {
          return;
        }
      }
      if (definition?.enabled && definition.trigger.type === "schedule") {
        await upsert(
          {
            id: jobId,
            task: FLOW_RUN_TASK,
            description: `Scheduled flow run for definition ${identity.id}`,
            schedule: flowScheduleToSchedulerSchedule(
              definition.trigger.schedule,
            ),
            payload: { definitionId: identity.id },
          },
          tx,
        );
        return;
      }
      await removeSchedulerJob(jobId, tx);
    },
  );
};
