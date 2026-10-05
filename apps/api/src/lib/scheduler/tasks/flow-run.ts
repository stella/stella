import { eq } from "drizzle-orm";
import * as v from "valibot";

import { schedulerJobs } from "@/api/db/schema";
import { isScheduledFlowDue } from "@/api/lib/flows/flow-trigger-logic";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import {
  brandPersistedFlowDefinitionId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
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
});

type StartScheduledFlowRun = (
  input: Parameters<typeof startAutomatedFlowRun>[0],
  db: SchedulerDb,
) => Promise<unknown>;

const startScheduledFlowRun: StartScheduledFlowRun = async (input, db) =>
  await startAutomatedFlowRun(input, automatedFlowRunDependencies(db));

/**
 * The task with its run starter supplied, so a test can drive the real
 * definition, workspace and due-day checks without starting steps.
 */
export const createScheduledFlowTask =
  (start: StartScheduledFlowRun): SchedulerTask =>
  async ({ db, dueAt, payload, logger }) => {
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
    if (!isScheduledFlowDue(trigger.schedule, dueAt)) {
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

    await start(
      {
        definitionId,
        organizationId,
        workspaceId,
        createdByUserId: definition.createdByUserId,
        triggerSource: { type: "schedule" },
        inputEntityIds: [],
        logContext: { definitionId, workspaceId, trigger: "schedule" },
      },
      db,
    );
  };

export const runScheduledFlow: SchedulerTask = createScheduledFlowTask(
  startScheduledFlowRun,
);
