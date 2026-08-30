/**
 * Boot-time orphan reconciler: after a restart that lost queued step jobs, every
 * pending/running run must be re-enqueued, not just the first batch. Driven
 * against a real (PGlite) database with a small batch size so the keyset
 * pagination's multi-batch path is exercised without seeding thousands of rows.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { organization } from "@/api/db/auth-schema";
import { flowRuns, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { reconcileOrphanedFlowRuns } from "@/api/lib/flows/flow-run-worker";
import type {
  FlowDefinitionSnapshot,
  FlowStep,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testDb: TestDatabase = await getTestDb();

const enqueuedRunIds: string[] = [];

const reconcileDependencies = asTestRaw<
  NonNullable<Parameters<typeof reconcileOrphanedFlowRuns>[1]>
>({
  database: testDb,
  enqueueStep: async ({ runId }: { runId: SafeId<"flowRun"> }) => {
    enqueuedRunIds.push(runId);
  },
});

const SNAPSHOT: FlowDefinitionSnapshot = {
  name: "Reconcile test flow",
  steps: [
    {
      kind: "ai",
      name: "Draft",
      prompt: "Draft.",
      includeDocuments: false,
    } satisfies FlowStep,
  ],
};

describe("reconcileOrphanedFlowRuns", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const userId = mintAuthProviderId<"user">();
  const nonTerminalRunIds: SafeId<"flowRun">[] = [];
  const stalledRunIds: SafeId<"flowRun">[] = [];
  const STALL_WINDOW_MS = 15 * 60 * 1000;
  const STALLED_AT = new Date(Date.now() - 60 * 60 * 1000);

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Reconcile Org",
      slug: `reconcile-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Reconcile matter",
      reference: "RECONCILE",
    });

    const triggerSource: FlowTriggerSource = { type: "manual", userId };
    // Five non-terminal runs (more than the batchSize below, so recovery must
    // cross batch boundaries) plus one terminal run that must be skipped.
    const rows = [
      { status: "pending" as const },
      { status: "running" as const },
      { status: "pending" as const },
      { status: "running" as const },
      { status: "pending" as const },
    ].map((row) => {
      const id = createSafeId<"flowRun">();
      nonTerminalRunIds.push(id);
      stalledRunIds.push(id);
      return {
        id,
        workspaceId,
        definitionSnapshot: SNAPSHOT,
        triggerSource,
        status: row.status,
        currentStepIndex: 0,
        createdAt: STALLED_AT,
      };
    });
    await testDb.insert(flowRuns).values(rows);

    // Just started: the standing sweep must leave it to the queue.
    const freshRunId = createSafeId<"flowRun">();
    nonTerminalRunIds.push(freshRunId);
    await testDb.insert(flowRuns).values({
      id: freshRunId,
      workspaceId,
      definitionSnapshot: SNAPSHOT,
      triggerSource,
      status: "running",
      currentStepIndex: 0,
      startedAt: new Date(),
    });
    await testDb.insert(flowRuns).values({
      id: createSafeId<"flowRun">(),
      workspaceId,
      definitionSnapshot: SNAPSHOT,
      triggerSource,
      status: "completed",
      currentStepIndex: 0,
    });
  });

  beforeEach(() => {
    enqueuedRunIds.length = 0;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  test("re-enqueues every pending/running run across batch boundaries", async () => {
    await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);

    expect(enqueuedRunIds.toSorted()).toEqual(
      [...nonTerminalRunIds].toSorted(),
    );
  });

  test("the standing sweep skips runs inside the stall window", async () => {
    await reconcileOrphanedFlowRuns(
      {
        batchSize: 2,
        stalledBefore: new Date(Date.now() - STALL_WINDOW_MS),
      },
      reconcileDependencies,
    );

    expect(enqueuedRunIds.toSorted()).toEqual([...stalledRunIds].toSorted());
  });
});
