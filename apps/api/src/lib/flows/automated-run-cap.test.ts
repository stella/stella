/**
 * Cap guard for automated (schedule / file-upload) flow runs. The count and the
 * insert are one atomic statement, so this exercises the SQL shape / semantics
 * without needing real concurrency (PGlite is single-connection): seed rows for
 * a definition, then assert the gated insert either lands or is refused.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { FlowStep, FlowTriggerSource } from "@/api/lib/flows/flow-types";
import { MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY } from "@/api/lib/flows/flow-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();

// The cap gate runs through `rootDb`; route it at the test database so the
// advisory lock, cross-workspace count, and insert run as real SQL.
void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));

const { insertAutomatedFlowRunWithinCap } =
  await import("@/api/lib/flows/automated-run-cap");
const { buildFlowRunRows } = await import("@/api/lib/flows/start-flow-run");

const CAP = MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY;

const AI_STEP: FlowStep = {
  kind: "ai",
  name: "Draft memo",
  prompt: "Draft a short legal memo.",
  includeDocuments: false,
};

const FILE_UPLOAD_SOURCE = {
  type: "file-upload",
  entityId: createSafeId<"entity">(),
} as const satisfies FlowTriggerSource;

describe("insertAutomatedFlowRunWithinCap", () => {
  let organizationId: SafeId<"organization">;
  let workspaceId: SafeId<"workspace">;

  const seedRun = async (
    definitionId: SafeId<"flowDefinition">,
    triggerSource: FlowTriggerSource,
    createdAt: Date,
  ): Promise<void> => {
    await testDb.insert(flowRuns).values({
      workspaceId,
      definitionId,
      definitionSnapshot: { name: "seed", steps: [] },
      triggerSource,
      createdAt,
    });
  };

  const seedRuns = async (
    definitionId: SafeId<"flowDefinition">,
    count: number,
    createdAt: Date,
  ): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- small fixed seed, ordering irrelevant
      await seedRun(definitionId, FILE_UPLOAD_SOURCE, createdAt);
    }
  };

  const createDefinition = async (): Promise<SafeId<"flowDefinition">> => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Automated cap flow",
      steps: [AI_STEP],
      trigger: {
        type: "file-upload",
        workspaceIds: null,
        fileExtensions: null,
      },
      enabled: true,
    });
    return definitionId;
  };

  const attemptStart = async (definitionId: SafeId<"flowDefinition">) => {
    const runId = createSafeId<"flowRun">();
    const rows = buildFlowRunRows({
      runId,
      workspaceId,
      definitionId,
      definition: { name: "Automated cap flow", steps: [AI_STEP] },
      triggerSource: FILE_UPLOAD_SOURCE,
      inputEntityIds: [],
    });
    const result = await insertAutomatedFlowRunWithinCap({
      definitionId,
      rows,
    });
    return { runId, result };
  };

  const countRunsForDefinition = async (
    definitionId: SafeId<"flowDefinition">,
  ): Promise<number> =>
    await testDb.$count(flowRuns, eq(flowRuns.definitionId, definitionId));

  beforeAll(async () => {
    organizationId = createSafeId<"organization">();
    workspaceId = createSafeId<"workspace">();
    const userId = createSafeId<"user">();

    await testDb.insert(organization).values({
      id: organizationId,
      name: "Automated cap org",
      slug: `automated-cap-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: userId,
      name: "Automated cap user",
      email: `${userId}@example.com`,
    });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Automated cap matter",
      reference: workspaceId.slice(0, 8),
    });
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  test("refuses to insert once today's automated cap is reached", async () => {
    const definitionId = await createDefinition();
    await seedRuns(definitionId, CAP, new Date());

    const { runId, result } = await attemptStart(definitionId);

    expect(result.outcome).toBe("capped");
    if (result.outcome === "capped") {
      expect(result.dailyRunCount).toBe(CAP);
    }
    // The row count is unchanged and the would-be run left no rows behind.
    expect(await countRunsForDefinition(definitionId)).toBe(CAP);
    const inserted = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { id: true },
    });
    expect(inserted).toBeUndefined();
    const stepRows = await testDb
      .select({ id: flowRunSteps.id })
      .from(flowRunSteps)
      .where(eq(flowRunSteps.runId, runId));
    expect(stepRows).toHaveLength(0);
  });

  test("inserts the run and its steps at the boundary (cap - 1)", async () => {
    const definitionId = await createDefinition();
    await seedRuns(definitionId, CAP - 1, new Date());

    const { runId, result } = await attemptStart(definitionId);

    expect(result.outcome).toBe("started");
    expect(await countRunsForDefinition(definitionId)).toBe(CAP);
    const inserted = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { id: true, status: true },
    });
    expect(inserted?.status).toBe("pending");
    const stepRows = await testDb
      .select({ id: flowRunSteps.id })
      .from(flowRunSteps)
      .where(eq(flowRunSteps.runId, runId));
    expect(stepRows).toHaveLength(1);
  });

  test("counts only today's automated runs, not manual or prior-day runs", async () => {
    const definitionId = await createDefinition();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Enough manual-today and automated-yesterday rows to blow the cap if they
    // were (wrongly) counted; neither should gate today's automated run.
    for (let index = 0; index < CAP; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- small fixed seed, ordering irrelevant
      await seedRun(
        definitionId,
        { type: "manual", userId: "manual-actor" },
        new Date(),
      );
      // oxlint-disable-next-line no-await-in-loop -- small fixed seed, ordering irrelevant
      await seedRun(definitionId, FILE_UPLOAD_SOURCE, yesterday);
    }

    const { result } = await attemptStart(definitionId);

    expect(result.outcome).toBe("started");
  });
});
