import { panic } from "better-result";
import type { SQL } from "bun";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  WORK_OBLIGATION_SOURCE,
  entities,
  flowRuns,
  flowRunSteps,
  workspaces,
  workspaceMembers,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import {
  cancelFlowRun,
  resolveFlowReviewGate,
} from "@/api/lib/flows/flow-executor";
import type { FlowStep } from "@/api/lib/flows/flow-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

type Action = "approved" | "rejected" | "cancel";

type FlowReviewGateFixtureOptions = {
  intermediate: boolean;
  governed?: boolean;
  initialRunStatus?: "pending" | "awaiting_review";
};

export const flowReviewGateFixture = async (
  db: GatedTestDb,
  {
    intermediate,
    governed = false,
    initialRunStatus = "awaiting_review",
  }: FlowReviewGateFixtureOptions,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const runId = createSafeId<"flowRun">();
  const taskEntityId = createSafeId<"entity">();
  const steps = [
    { kind: "review-gate", name: "Review", instructions: "Review the output" },
  ] satisfies FlowStep[];
  if (intermediate) {
    steps.push({
      kind: "review-gate",
      name: "Next review",
      instructions: "Review the next output",
    });
  }
  const cleanup = async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Review fixture",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values({
      id: userId,
      name: "Reviewer",
      email: `${userId}@example.test`,
    });
    await db.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Review matter",
      reference: workspaceId,
    });
    await db.insert(workspaceMembers).values({ workspaceId, userId });
    await db.insert(entities).values({
      id: taskEntityId,
      workspaceId,
      kind: "task",
      name: "Review task",
      status: "open",
    });
    if (governed) {
      await db.insert(workObligations).values({
        entityId: taskEntityId,
        workspaceId,
        sourceType: WORK_OBLIGATION_SOURCE.FLOW,
        status: "active",
        ownerUserId: userId,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
        createdByUserId: userId,
      });
    }
    await db.insert(flowRuns).values({
      id: runId,
      workspaceId,
      status: initialRunStatus,
      definitionSnapshot: { name: "Review flow", steps },
      triggerSource: { type: "manual", userId },
    });
    await db.insert(flowRunSteps).values(
      steps.map((step, index) => ({
        id: createSafeId<"flowRunStep">(),
        workspaceId,
        runId,
        index,
        kind: step.kind,
        reviewTaskEntityId: index === 0 ? taskEntityId : null,
        status: index === 0 ? initialRunStatus : ("pending" as const),
      })),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "system", source: "review_gate_test" },
    },
  });
  const enqueued: number[] = [];
  let actionIndex = 0;
  const act = async (safeDb: SafeDb, action: Action) => {
    const note = `${action}:${actionIndex}`;
    actionIndex += 1;
    return action === "cancel"
      ? await cancelFlowRun({
          safeDb,
          workspaceId,
          runId,
          userId,
          recordAuditEvent,
        })
      : await resolveFlowReviewGate(
          {
            safeDb,
            workspaceId,
            organizationId,
            runId,
            userId,
            recordAuditEvent,
            decision: action,
            note,
          },
          {
            broadcastUpdate: () => undefined,
            enqueueStep: async ({ stepIndex }) => {
              enqueued.push(stepIndex);
              await Promise.resolve(undefined);
            },
            notifyRunCompleted: async () => await Promise.resolve(undefined),
          },
        );
  };
  const read = async () => ({
    task: await db.query.entities.findFirst({
      where: { id: { eq: taskEntityId } },
    }),
    obligation: await db.query.workObligations.findFirst({
      where: { entityId: { eq: taskEntityId } },
    }),
    run: await db.query.flowRuns.findFirst({ where: { id: { eq: runId } } }),
    steps: await db.query.flowRunSteps.findMany({
      where: { runId: { eq: runId } },
      orderBy: { index: "asc" },
    }),
  });
  const safeDb = (database: GatedTestDb) =>
    createSafeDb(
      markRlsDatabase(database),
      [workspaceId],
      organizationId,
      userId,
    );
  return {
    organizationId,
    userId,
    workspaceId,
    runId,
    taskEntityId,
    recordAuditEvent,
    enqueued,
    safeDb,
    act,
    read,
    cleanup,
  };
};

// A query logger marks arrival; this observation proves the session waited.
// This bounded DB observation is used only in concurrency regressions.
export const waitForBlockedPid = async (
  observer: SQL,
  { waitingPid, holdingPid }: { waitingPid: number; holdingPid: number },
) => {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const rows = await observer<
      { waiting: boolean }[]
    >`select ${holdingPid} = any(pg_blocking_pids(${waitingPid})) as waiting`;
    if (rows.at(0)?.waiting === true) {
      return;
    }
  }
  panic(`Session ${waitingPid} did not wait for ${holdingPid}`);
};
