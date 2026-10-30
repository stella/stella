import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import { flowDefinitions, schedulerJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { runGlobalSystemWork } from "@/api/lib/db/global-system-work";
import { writeSchedulerBookkeeping } from "@/api/lib/db/recovery-bookkeeping/scheduler";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { isScheduledFlowDue } from "@/api/lib/flows/flow-trigger-logic";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type { StartAutomatedFlowRunOutcome } from "@/api/lib/flows/start-automated-flow-run";
import {
  brandPersistedFlowDefinitionId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type {
  SchedulerDb,
  SchedulerJob,
  SchedulerTask,
} from "@/api/lib/scheduler/types";

const retainedSlotFields = {
  pendingDueAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  pendingClaimedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
};

export const flowRunPayloadSchema = v.strictObject({
  definitionId: v.pipe(v.string(), v.uuid()),
  ...retainedSlotFields,
});

type FlowRunPayloadMatchesSqlOptions = {
  payload: SQLWrapper;
  definitionId: SQLWrapper;
};

/** Repair preserves only payloads the task accepts, including retained slot identity. */
export const flowRunPayloadMatchesSql = ({
  payload,
  definitionId,
}: FlowRunPayloadMatchesSqlOptions) => {
  const retainedKeys = Object.keys(retainedSlotFields);
  const validSlots = retainedKeys.map(
    (key) => sql`(
    NOT (${payload} ? ${key}) OR (
      jsonb_typeof(${payload}->${key}) = 'string'
      AND ${payload}->>${key} ~ ${v.ISO_TIMESTAMP_REGEX.source}
    )
  )`,
  );
  return sql`CASE WHEN jsonb_typeof(${payload}) = 'object' THEN COALESCE((
    (${payload} - ARRAY[${sql.join(
      retainedKeys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[])
      = jsonb_build_object('definitionId', (${definitionId})::text)
    AND ${sql.join(validSlots, sql` AND `)}
  ), false) ELSE false END`;
};

type StartScheduledFlowRun = (
  input: Parameters<typeof startAutomatedFlowRun>[0],
  db: SchedulerDb,
) => Promise<StartAutomatedFlowRunOutcome>;

const startScheduledFlowRun: StartScheduledFlowRun = async (input, db) =>
  await startAutomatedFlowRun(input, automatedFlowRunDependencies(db));

const SLOT_SETTLEMENT_REASON = { NOT_DUE: "retained_slot_not_due" } as const;

// The scheduler mints a unique lockedBy token for every lease acquisition.
const originalScheduleClaim = (job: SchedulerJob) => ({
  jobId: job.id,
  lockedBy: job.lockedBy ?? panic("Scheduled flow requires a scheduler lease"),
});

type PersistScheduleSlotOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  definitionId: SafeId<"flowDefinition">;
  settlement: { status: "retained"; dueSlot: DueSlot } | { status: "settled" };
};

const persistScheduleSlot = async ({
  db,
  job,
  definitionId,
  settlement,
}: PersistScheduleSlotOptions) => {
  const payload =
    settlement.status === "retained"
      ? {
          definitionId,
          pendingDueAt: settlement.dueSlot.toDate().toISOString(),
          pendingClaimedAt: settlement.dueSlot.claimedAtDate().toISOString(),
        }
      : { definitionId };
  return await withAggregateTransaction(db, async (tx) => {
    const proof = await proveOrgScope(tx, {
      table: "flowDefinitions",
      where: eq(flowDefinitions.id, definitionId),
    });
    if (proof.isErr()) {
      return { status: "stale" } as const;
    }
    return await withOrgScope({
      tx,
      scope: proof.value,
      actor: { type: "system" },
      fn: async (_scopedTx, scoped) => {
        const changed = await writeSchedulerBookkeeping({
          type: "checkpoint-slot",
          db: scoped,
          table: schedulerJobs,
          ...originalScheduleClaim(job),
          payload,
        });
        return changed.length === 0
          ? ({ status: "stale" } as const)
          : ({ status: "persisted" } as const);
      },
    });
  });
};

/**
 * The task with its run starter supplied, so a test can drive the real
 * definition, workspace and due-day checks without starting steps.
 */
export const createScheduledFlowTask =
  (start: StartScheduledFlowRun): SchedulerTask =>
  async ({ db, dueAt, job, payload, logger, scheduleContinuation }) => {
    const parsed = v.safeParse(flowRunPayloadSchema, payload);
    if (!parsed.success) {
      logger.error("flow.schedule_invalid_payload", {
        issues: parsed.issues.length,
      });
      return;
    }

    const definitionId = brandPersistedFlowDefinitionId(
      parsed.output.definitionId,
    );
    const definition = await db.query.flowDefinitions.findFirst({
      where: { id: { eq: definitionId } },
      columns: {
        id: true,
        organizationId: true,
        trigger: true,
        enabled: true,
        createdByUserId: true,
      },
    });

    if (!definition) {
      // Definition deleted without a sync (e.g. cascade from org deletion): drop
      // the orphaned scheduler row so it stops firing.
      const claim = originalScheduleClaim(job);
      await runGlobalSystemWork(db, {
        type: "flow-schedule-orphan-claim",
        definitionId,
        jobId: claim.jobId,
        lockedBy: claim.lockedBy,
      });
      logger.info("flow.schedule_definition_missing", { definitionId });
      return;
    }

    if (!definition.enabled || definition.trigger.type !== "schedule") {
      // A disabled flow or a trigger changed away from `schedule`; the sync hook
      // owns row removal, so just skip this tick.
      logger.info("flow.schedule_inactive", {
        definitionId,
        enabled: definition.enabled,
        triggerType: definition.trigger.type,
      });
      return;
    }

    const trigger = definition.trigger;
    let originalSlot =
      parsed.output.pendingDueAt === undefined
        ? dueAt
        : DueSlot.of({
            nextRunAt: new Date(parsed.output.pendingDueAt),
            // Existing receipts contain only their due timestamp; they cannot certify a later covered window.
            lockedAt:
              parsed.output.pendingClaimedAt === undefined
                ? null
                : new Date(parsed.output.pendingClaimedAt),
          });
    if (
      parsed.output.pendingDueAt !== undefined &&
      !isScheduledFlowDue(trigger.schedule, originalSlot)
    ) {
      if (
        (
          await persistScheduleSlot({
            db,
            job,
            definitionId,
            settlement: { status: "settled" },
          })
        ).status === "stale"
      ) {
        return;
      }
      logger.info("flow.schedule_slot_settled", {
        definitionId,
        pendingDueAt: parsed.output.pendingDueAt,
        reason: SLOT_SETTLEMENT_REASON.NOT_DUE,
      });
      originalSlot = dueAt;
    }
    if (!isScheduledFlowDue(trigger.schedule, originalSlot)) {
      logger.debug("flow.schedule_not_due_today", {
        definitionId,
        frequency: trigger.schedule.frequency,
      });
      return;
    }

    const retrySlot = async () => {
      if (
        (
          await persistScheduleSlot({
            db,
            job,
            definitionId,
            settlement: { status: "retained", dueSlot: originalSlot },
          })
        ).status === "stale"
      ) {
        return;
      }
      scheduleContinuation(
        new Date(dueAt.claimedAtDate().getTime() + 5 * 60 * 1000),
      );
    };
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      logger.info("flow.schedule_skipped", { reason: "deployment_disabled" });
      await retrySlot();
      return;
    }
    if (
      !(await isBackgroundFeatureEnabled({
        tx: db,
        organizationId: brandPersistedOrganizationId(definition.organizationId),
        userId: definition.createdByUserId,
        featureId: "flows",
      }))
    ) {
      logger.info("flow.schedule_skipped", {
        reason: "actor_not_granted",
        definitionId,
      });
      await retrySlot();
      return;
    }

    const organizationId = brandPersistedOrganizationId(
      definition.organizationId,
    );
    const workspaceId = brandPersistedWorkspaceId(trigger.workspaceId);
    const workspace = await db.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { organizationId: true, status: true },
    });
    if (
      !workspace ||
      workspace.organizationId !== definition.organizationId ||
      workspace.status !== "active"
    ) {
      logger.warn("flow.schedule_workspace_unavailable", {
        definitionId,
        workspaceId,
        workspaceStatus: workspace?.status ?? "missing",
      });
      return;
    }

    const outcome = await start(
      {
        definitionId,
        organizationId,
        workspaceId,
        createdByUserId: definition.createdByUserId,
        expectedScheduleTrigger: trigger,
        triggerSource: {
          type: "schedule",
          dueSlot: originalSlot.toDate().toISOString(),
        },
        inputEntityIds: [],
        schedulerClaim: originalScheduleClaim(job),
        logContext: { definitionId, workspaceId, trigger: "schedule" },
      },
      db,
    );
    if (outcome.status === "stale") {
      logger.info("flow.schedule_stale", { definitionId });
      return;
    }
    if (outcome.status === "paused" || outcome.status === "retry") {
      await retrySlot();
      return;
    }
    if (parsed.output.pendingDueAt !== undefined) {
      await persistScheduleSlot({
        db,
        job,
        definitionId,
        settlement: { status: "settled" },
      });
    }
  };

export const runScheduledFlow: SchedulerTask = createScheduledFlowTask(
  startScheduledFlowRun,
);
