import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  flowRuns,
  featureEnrolments,
  flowRunSteps,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  cancelFlowRun,
  executeFlowStep,
  failFlowRunFromWorker,
  FlowStepError,
} from "@/api/lib/flows/flow-executor";
import type { FlowRunStatus, FlowStep } from "@/api/lib/flows/flow-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
type WorkerDependencies = Parameters<typeof executeFlowStep>[2];
const database = asTestRaw<WorkerDependencies["database"]>(db);
const makeScopedDb = asTestRaw<NonNullable<WorkerDependencies["makeScopedDb"]>>(
  (scope: Parameters<NonNullable<WorkerDependencies["makeScopedDb"]>>[0]) =>
    "workspaceIds" in scope
      ? createScopedDb(
          db,
          scope.workspaceIds,
          scope.organizationId,
          scope.userId,
        )
      : createScopedDb(
          db,
          scope.workspaceScope,
          scope.organizationId,
          scope.userId,
        ),
);
const safeDb = asTestRaw<SafeDb>(
  createSafeDb(db, [workspaceId], organizationId, userId),
);

beforeAll(async () => {
  await db.insert(organization).values({
    id: organizationId,
    name: "Lifecycle fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Reviewer",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await db
    .insert(featureEnrolments)
    .values({ organizationId, userId, featureId: "flows" });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Lifecycle matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
});
afterAll(async () => {
  try {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  } finally {
    await releaseTestDb();
  }
});

const seedRun = async (status: FlowRunStatus = "pending") => {
  const runId = createSafeId<"flowRun">();
  const steps = [
    { kind: "review-gate", name: "Review", instructions: "" },
    { kind: "review-gate", name: "Next", instructions: "" },
  ] satisfies FlowStep[];
  await db.insert(flowRuns).values({
    id: runId,
    workspaceId,
    status,
    definitionSnapshot: { name: "Lifecycle", steps },
    triggerSource: { type: "manual", userId },
  });
  await db.insert(flowRunSteps).values(
    steps.map((step, index) => ({
      id: createSafeId<"flowRunStep">(),
      workspaceId,
      runId,
      index,
      kind: step.kind,
      status:
        index === 0 && status === "awaiting_review"
          ? ("awaiting_review" as const)
          : ("pending" as const),
    })),
  );
  return runId;
};

describe("flow review lifecycle", () => {
  test.each(["start", "pause", "failure"] as const)(
    "worker quietly finishes when run is deleted before %s",
    async (boundary) => {
      const runId = await seedRun();
      let calls = 0;
      const deletingScope: typeof makeScopedDb = (scope) => async (work) => {
        calls += 1;
        if (calls === (boundary === "pause" ? 2 : 1)) {
          await db.delete(flowRuns).where(eq(flowRuns.id, runId));
        }
        return await makeScopedDb(scope)(work);
      };
      const broadcasts: unknown[] = [];
      const broadcastUpdate = (_workspace: unknown, payload: unknown) => {
        broadcasts.push(payload);
      };
      if (boundary === "failure") {
        await failFlowRunFromWorker(
          { runId, stepIndex: 0 },
          new FlowStepError({ message: "Step refused" }),
          {
            database:
              asTestRaw<
                Parameters<typeof failFlowRunFromWorker>[2]["database"]
              >(db),
            makeScopedDb: deletingScope,
            broadcastUpdate,
          },
        );
      } else {
        await executeFlowStep(
          { runId, stepIndex: 0 },
          new AbortController().signal,
          {
            admission: testModelAdmission(organizationId),
            database,
            makeScopedDb: deletingScope,
            broadcastUpdate,
            enqueueStep: async () => {
              throw new Error("A deleted run must not enqueue");
            },
            taskFeatures: { governedWorkflow: false, legalLists: false },
          },
        );
      }
      expect(
        await db.query.flowRuns.findFirst({ where: { id: { eq: runId } } }),
      ).toBeUndefined();
      expect(broadcasts).toHaveLength(boundary === "pause" ? 1 : 0);
    },
  );

  test("a late worker failure leaves a waiting review unchanged", async () => {
    const runId = await seedRun("awaiting_review");
    const read = async () => ({
      run: await db.query.flowRuns.findFirst({ where: { id: { eq: runId } } }),
      steps: await db.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
        orderBy: { index: "asc" },
      }),
    });
    const before = await read();
    await failFlowRunFromWorker(
      { runId, stepIndex: 0 },
      new FlowStepError({ message: "Late worker failure" }),
      {
        database:
          asTestRaw<Parameters<typeof failFlowRunFromWorker>[2]["database"]>(
            db,
          ),
        makeScopedDb,
        broadcastUpdate: () => undefined,
      },
    );
    expect(await read()).toEqual(before);
  });

  test.each(["pending", "running"] as const)(
    "a cancellation accepts worker progress after observing %s",
    async (observedStatus) => {
      const runId = await seedRun(observedStatus);
      let calls = 0;
      const advancingDb: SafeDb = async (work, retry) => {
        const result = await safeDb(work, retry);
        calls += 1;
        if (calls === 1) {
          await db
            .update(flowRuns)
            .set({
              status: "running",
              currentStepIndex: observedStatus === "pending" ? 0 : 1,
            })
            .where(eq(flowRuns.id, runId));
        }
        return result;
      };
      const result = await cancelFlowRun({
        safeDb: advancingDb,
        workspaceId,
        runId,
        userId,
        recordAuditEvent: async () => undefined,
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      expect(result.value.status).toBe("cancelled");
      expect(
        (
          await db.query.flowRunSteps.findMany({
            where: { runId: { eq: runId } },
          })
        ).every((step) => step.status === "skipped"),
      ).toBe(true);
    },
  );
});
