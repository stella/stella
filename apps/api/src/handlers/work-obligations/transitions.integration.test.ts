import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import {
  entities,
  flowRuns,
  flowRunSteps,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import acknowledgeWorkObligation from "@/api/handlers/work-obligations/acknowledgements/create";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { FlowStep } from "@/api/lib/flows/flow-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type AcknowledgeContext = Parameters<
  typeof acknowledgeWorkObligation.handler
>[0];
type TransitionContext = Parameters<typeof transitionWorkObligation.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const taskIds: SafeId<"entity">[] = [];
const runIds: SafeId<"flowRun">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (runIds.length > 0) {
      await testDb.delete(flowRuns).where(inArray(flowRuns.id, runIds));
    }
    if (taskIds.length > 0) {
      await testDb.delete(entities).where(inArray(entities.id, taskIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const seedAwaitingWork = async () => {
  const entityId = createSafeId<"entity">();
  taskIds.push(entityId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    name: "Governed test task",
    status: "open",
    createdBy: ids.userA1,
  });
  await testDb.insert(workObligations).values({
    entityId,
    workspaceId: ids.wsA1,
    ownerUserId: ids.userA1,
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    createdByUserId: ids.userA2,
  });
  return entityId;
};

const REVIEW_GATE_STEP: FlowStep = {
  kind: "review-gate",
  name: "Partner sign-off",
  instructions: "Check the draft before it goes out.",
};
const AI_STEP: FlowStep = {
  kind: "ai",
  name: "Draft",
  prompt: "Draft the letter.",
  includeDocuments: false,
};

/**
 * A run paused at its first gate, with the task that gate raised for userA1:
 * the shape `pauseAtReviewGate` leaves behind, seeded directly so the test
 * needs no worker.
 */
const seedFlowReviewWork = async () => {
  const entityId = createSafeId<"entity">();
  const runId = createSafeId<"flowRun">();
  taskIds.push(entityId);
  runIds.push(runId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    name: "Letter flow · Partner sign-off",
    status: "open",
    createdBy: ids.userA1,
  });
  await testDb.insert(workObligations).values({
    entityId,
    workspaceId: ids.wsA1,
    ownerUserId: ids.userA1,
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    acknowledgedAt: new Date(),
    acknowledgedByUserId: ids.userA1,
    sourceType: WORK_OBLIGATION_SOURCE.FLOW,
    createdByUserId: ids.userA1,
  });
  await testDb.insert(flowRuns).values({
    id: runId,
    workspaceId: ids.wsA1,
    definitionSnapshot: {
      name: "Letter flow",
      steps: [REVIEW_GATE_STEP, AI_STEP],
    },
    triggerSource: { type: "manual", userId: ids.userA1 },
    status: "awaiting_review",
    currentStepIndex: 0,
    startedAt: new Date(),
  });
  await testDb.insert(flowRunSteps).values({
    id: createSafeId<"flowRunStep">(),
    workspaceId: ids.wsA1,
    runId,
    index: 0,
    kind: "review-gate",
    status: "awaiting_review",
    reviewTaskEntityId: entityId,
    startedAt: new Date(),
  });
  return { entityId, runId };
};

const contextBase = (userId: SafeId<"user">) => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, userId);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, userId);
  const recordAuditEvent: AcknowledgeContext["recordAuditEvent"] = async () =>
    undefined;

  return {
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    createAuditRecorder: () => recordAuditEvent,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    promptCachingEnabled: false,
    recordAuditEvent,
    request: new Request("https://example.test/work-obligations"),
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: userId },
    workspaceId: ids.wsA1,
  };
};

const acknowledge = async (
  entityId: SafeId<"entity">,
  userId: SafeId<"user">,
) =>
  await acknowledgeWorkObligation.handler(
    asTestRaw<AcknowledgeContext>({
      ...contextBase(userId),
      params: { workspaceId: ids.wsA1, entityId },
      route: "/test/work-obligations/acknowledge",
    }),
  );

const transition = async (
  entityId: SafeId<"entity">,
  userId: SafeId<"user">,
  action: TransitionContext["body"]["action"],
  options: {
    reason?: string;
    role?: TransitionContext["memberRole"]["role"];
  } = {},
) =>
  await transitionWorkObligation.handler(
    asTestRaw<TransitionContext>({
      ...contextBase(userId),
      ...(options.role === undefined
        ? {}
        : { memberRole: { role: options.role } }),
      body: {
        action,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      params: { workspaceId: ids.wsA1, entityId },
      route: "/test/work-obligations/transition",
    }),
  );

describe("work obligation transitions", () => {
  test("acknowledgement is an idempotent fixed point", async () => {
    const entityId = await seedAwaitingWork();

    expect(await acknowledge(entityId, ids.userA1)).toEqual({ success: true });
    expect(await acknowledge(entityId, ids.userA1)).toEqual({ success: true });

    const events = await testDb.query.workObligationEvents.findMany({
      where: {
        obligationEntityId: { eq: entityId },
        type: { eq: "acknowledged" },
      },
    });
    expect(events).toHaveLength(1);
  });

  test("only the owner can acknowledge or complete work", async () => {
    const entityId = await seedAwaitingWork();

    expect(await acknowledge(entityId, ids.userA2)).toEqual({
      code: 403,
      response: {
        message: "Only the accountable owner can acknowledge this work",
      },
    });
    await acknowledge(entityId, ids.userA1);
    expect(await transition(entityId, ids.userA2, "complete")).toEqual({
      code: 403,
      response: {
        message: "Only the accountable owner can complete this work",
      },
    });
    expect(await transition(entityId, ids.userA1, "complete")).toEqual({
      success: true,
    });

    const obligation = await testDb.query.workObligations.findFirst({
      where: { entityId: { eq: entityId } },
      columns: { status: true },
    });
    const task = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { status: true },
    });
    expect(obligation?.status).toBe(WORK_OBLIGATION_STATUS.COMPLETED);
    expect(task?.status).toBe("done");
  });

  test("cancelling the task a review gate raised rejects the gate", async () => {
    const { entityId, runId } = await seedFlowReviewWork();

    expect(
      await transition(entityId, ids.userA1, "cancel", {
        reason: "Needs another pass",
      }),
    ).toEqual({ success: true });

    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true },
    });
    const step = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { status: true, output: true },
    });
    const obligation = await testDb.query.workObligations.findFirst({
      where: { entityId: { eq: entityId } },
      columns: { status: true },
    });
    const task = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { status: true },
    });
    expect(run?.status).toBe("cancelled");
    expect(step?.status).toBe("completed");
    expect(step?.output).toEqual({
      kind: "review-gate",
      decision: "rejected",
      userId: ids.userA1,
      note: "Needs another pass",
    });
    // The decision fulfils the review task even when it rejects the draft.
    expect(obligation?.status).toBe(WORK_OBLIGATION_STATUS.COMPLETED);
    expect(task?.status).toBe("done");
  });

  test("a gate task cannot be reopened", async () => {
    const { entityId } = await seedFlowReviewWork();

    expect(await transition(entityId, ids.userA1, "reopen")).toEqual({
      code: 409,
      response: {
        message:
          "A workflow review cannot be reopened; start the workflow again instead",
      },
    });
  });
});
