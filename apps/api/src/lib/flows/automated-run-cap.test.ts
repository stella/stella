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
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { insertAutomatedFlowRunWithinCap } from "@/api/lib/flows/automated-run-cap";
import type { FlowStep, FlowTriggerSource } from "@/api/lib/flows/flow-types";
import { MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY } from "@/api/lib/flows/flow-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();
const capDatabase =
  asTestRaw<
    NonNullable<
      Parameters<typeof insertAutomatedFlowRunWithinCap>[0]["database"]
    >
  >(testDb);

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
      await seedRun(
        definitionId,
        { type: "file-upload", entityId: createSafeId<"entity">() },
        createdAt,
      );
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

  const attemptStart = async (
    definitionId: SafeId<"flowDefinition">,
    reservePeriod?: () => Promise<void>,
    runId: SafeId<"flowRun"> = createSafeId<"flowRun">(),
    triggerSource: FlowTriggerSource = FILE_UPLOAD_SOURCE,
  ) => {
    const rows = buildFlowRunRows({
      runId,
      workspaceId,
      definitionId,
      definition: { name: "Automated cap flow", steps: [AI_STEP] },
      triggerSource,
      inputEntityIds: [],
    });
    const result = await insertAutomatedFlowRunWithinCap({
      definitionId,
      rows,
      database: capDatabase,
      ...(reservePeriod && { reservePeriod }),
    });
    return { runId, result };
  };

  const countRunsForDefinition = async (
    definitionId: SafeId<"flowDefinition">,
  ): Promise<number> =>
    await testDb.$count(flowRuns, eq(flowRuns.definitionId, definitionId));

  beforeAll(async () => {
    organizationId = mintAuthProviderId<"organization">();
    workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();

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

  test("reserves one period slot for the accepted run and none for a capped retry", async () => {
    const definitionId = await createDefinition();
    await seedRuns(definitionId, CAP - 1, new Date());
    let reserved = 0;
    const reservePeriod = async () => {
      reserved += 1;
    };

    const accepted = await attemptStart(definitionId, reservePeriod);
    expect(accepted.result.outcome).toBe("started");
    expect(reserved).toBe(1);

    const replay = await attemptStart(definitionId, reservePeriod);
    expect(replay.result.outcome).toBe("already-started");
    expect(reserved).toBe(1);
    const cappedRetry = await attemptStart(
      definitionId,
      reservePeriod,
      createSafeId<"flowRun">(),
      { type: "file-upload", entityId: createSafeId<"entity">() },
    );
    expect(cappedRetry.result.outcome).toBe("capped");
    expect(reserved).toBe(1);
  });

  test("scheduled due-slot replay is a fixed point before the daily cap", async () => {
    const definitionId = await createDefinition();
    await seedRuns(definitionId, CAP - 1, new Date());
    const triggerSource = {
      type: "schedule",
      dueSlot: "2030-01-01T23:00:00.000Z",
    } as const satisfies FlowTriggerSource;
    let reservations = 0;
    const reservePeriod = async () => {
      reservations += 1;
    };
    const first = await attemptStart(
      definitionId,
      reservePeriod,
      createSafeId<"flowRun">(),
      triggerSource,
    );
    expect(first.result.outcome).toBe("started");
    const replay = await attemptStart(
      definitionId,
      reservePeriod,
      createSafeId<"flowRun">(),
      triggerSource,
    );
    expect(replay.result.outcome).toBe("already-started");
    expect(reservations).toBe(1);
    expect(await countRunsForDefinition(definitionId)).toBe(CAP);
    expect(
      await testDb.$count(flowRunSteps, eq(flowRunSteps.runId, replay.runId)),
    ).toBe(0);
  });

  test("distinct scheduled slots remain independent of legacy unidentified runs", async () => {
    const definitionId = await createDefinition();
    await seedRun(definitionId, { type: "schedule" }, new Date(0));
    for (const dueSlot of [
      "2030-01-01T23:00:00.000Z",
      "2030-01-02T23:00:00.000Z",
    ]) {
      // db-await-in-loop: exercise independent deliveries and their immediate replay under the definition lock.
      const first = await attemptStart(
        definitionId,
        undefined,
        createSafeId<"flowRun">(),
        { type: "schedule", dueSlot },
      );
      expect(first.result.outcome).toBe("started");
      // db-await-in-loop: the replay must converge to the already committed delivery.
      const replay = await attemptStart(
        definitionId,
        undefined,
        createSafeId<"flowRun">(),
        { type: "schedule", dueSlot },
      );
      expect(replay.result.outcome).toBe("already-started");
    }
    expect(await countRunsForDefinition(definitionId)).toBe(3);
  });

  test("rolls run and step rows back when period reservation refuses", async () => {
    const definitionId = await createDefinition();
    const before = await countRunsForDefinition(definitionId);
    const runId = createSafeId<"flowRun">();
    const reservePeriod = async () => {
      throw new HandlerError({
        status: 429,
        message: "Action period limit reached",
      });
    };

    const operation = attemptStart(definitionId, reservePeriod, runId);

    expect(await operation.catch((error: unknown) => error)).toMatchObject({
      _tag: "HandlerError",
      status: 429,
      message: "Action period limit reached",
    });
    expect(await countRunsForDefinition(definitionId)).toBe(before);
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

  test("counts only today's automated runs, not manual or prior-day runs", async () => {
    const definitionId = await createDefinition();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Enough manual-today and automated-yesterday rows to blow the cap if they
    // were (wrongly) counted; neither should gate today's automated run.
    for (let index = 0; index < CAP; index += 1) {
      await seedRun(
        definitionId,
        { type: "manual", userId: "manual-actor" },
        new Date(),
      );
      await seedRun(
        definitionId,
        { type: "file-upload", entityId: createSafeId<"entity">() },
        yesterday,
      );
    }

    const { result } = await attemptStart(definitionId);

    expect(result.outcome).toBe("started");
  });

  test("upload replay converges across calendar days without inserting duplicate steps", async () => {
    const definitionId = await createDefinition();
    await seedRun(
      definitionId,
      FILE_UPLOAD_SOURCE,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    const replay = await attemptStart(definitionId);
    expect(replay.result.outcome).toBe("already-started");
    expect(await countRunsForDefinition(definitionId)).toBe(1);
    expect(
      await testDb
        .select()
        .from(flowRunSteps)
        .where(eq(flowRunSteps.runId, replay.runId)),
    ).toHaveLength(0);
  });
});
