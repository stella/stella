import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { schedulerJobs } from "@/api/db/schema";
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
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

/**
 * Scheduler task backing a definition's `schedule` trigger. One
 * `scheduler_jobs` row per schedule-triggered definition (see
 * `syncFlowScheduleTrigger`) fires this daily at the trigger's UTC hour; the
 * task gates weekly / monthly frequencies to the day of the slot that was due, revalidates the
 * definition + target workspace, then defers to `startAutomatedFlowRun` (actor
 * guarantee + daily cap + run start).
 */
export const FLOW_RUN_TASK = "flow.run" as const;

/** Deterministic scheduler-job id so one definition owns at most one row. */
export const flowScheduleJobId = (definitionId: string): string =>
  `flow.run.${definitionId}`;

const flowRunPayloadSchema = v.strictObject({
  definitionId: v.pipe(v.string(), v.uuid()),
  pendingDueAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

type StartScheduledFlowRun = (
  input: Parameters<typeof startAutomatedFlowRun>[0],
  db: SchedulerDb,
) => Promise<StartAutomatedFlowRunOutcome>;

const startScheduledFlowRun: StartScheduledFlowRun = async (input, db) =>
  await startAutomatedFlowRun(input, automatedFlowRunDependencies(db));

/**
 * The task with its run starter supplied, so a test can drive the real
 * definition, workspace and due-day checks without starting steps.
 */
export const createScheduledFlowTask =
  (start: StartScheduledFlowRun): SchedulerTask =>
  async ({ db, dueAt, job, payload, logger, scheduleContinuation }) => {
    const retrySlot = async () => {
      const leaseToken =
        job.lockedBy ?? panic("Scheduled flow requires a scheduler lease");
      const pendingDueAt =
        typeof payload?.["pendingDueAt"] === "string"
          ? payload["pendingDueAt"]
          : dueAt.toDate().toISOString();
      // audit: skip — retains the original due slot; scheduler_job_runs records each attempt.
      await db
        .update(schedulerJobs)
        .set({ payload: { ...payload, pendingDueAt } })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.lockedBy, leaseToken),
          ),
        );
      scheduleContinuation(
        new Date(dueAt.claimedAtDate().getTime() + 5 * 60 * 1000),
      );
    };
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      logger.info("flow.schedule_skipped", { reason: "deployment_disabled" });
      await retrySlot();
      return;
    }
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
      // audit: skip — scheduler bookkeeping for a definition that no longer
      // exists; no user-owned record changes.
      await db
        .delete(schedulerJobs)
        .where(eq(schedulerJobs.id, flowScheduleJobId(definitionId)));
      logger.info("flow.schedule_definition_missing", { definitionId });
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
    const originalSlot =
      parsed.output.pendingDueAt === undefined
        ? dueAt
        : DueSlot.of({
            nextRunAt: new Date(parsed.output.pendingDueAt),
            lockedAt: dueAt.claimedAtDate(),
          });
    if (!isScheduledFlowDue(trigger.schedule, originalSlot)) {
      logger.debug("flow.schedule_not_due_today", {
        definitionId,
        frequency: trigger.schedule.frequency,
      });
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
        triggerSource: {
          type: "schedule",
          dueSlot: originalSlot.toDate().toISOString(),
        },
        inputEntityIds: [],
        logContext: { definitionId, workspaceId, trigger: "schedule" },
      },
      db,
    );
    if (outcome.status === "paused" || outcome.status === "retry") {
      await retrySlot();
      return;
    }
    if (parsed.output.pendingDueAt !== undefined) {
      const leaseToken =
        job.lockedBy ?? panic("Scheduled flow requires a scheduler lease");
      // audit: skip — retains the original due slot; scheduler_job_runs records each attempt.
      await db
        .update(schedulerJobs)
        .set({ payload: { definitionId } })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.lockedBy, leaseToken),
          ),
        );
    }
  };

export const runScheduledFlow: SchedulerTask = createScheduledFlowTask(
  startScheduledFlowRun,
);
