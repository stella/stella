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
import type { SQL } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { aggregateExecutionRows } from "@/api/lib/db/aggregate-lock-order.fixture";
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

  const attemptStart = async (
    definitionId: SafeId<"flowDefinition">,
    reservePeriod?: () => Promise<void>,
    runId: SafeId<"flowRun"> = createSafeId<"flowRun">(),
  ) => {
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

    const cappedRetry = await attemptStart(definitionId, reservePeriod);
    expect(cappedRetry.result.outcome).toBe("capped");
    expect(reserved).toBe(1);
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
      await seedRun(definitionId, FILE_UPLOAD_SOURCE, yesterday);
    }

    const { result } = await attemptStart(definitionId);

    expect(result.outcome).toBe("started");
  });
});

test("pending automated evidence retains the prepared execution rows", async () => {
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const definitionId = createSafeId<"flowDefinition">();
  const originalInput = createSafeId<"entity">();
  const runId = createSafeId<"flowRun">();
  const rows = buildFlowRunRows({
    runId,
    workspaceId: createSafeId<"workspace">(),
    definitionId,
    definition: { name: "Prepared", steps: [AI_STEP] },
    triggerSource: { type: "schedule" },
    inputEntityIds: [originalInput],
  });
  const written: unknown[] = [];
  const database = asTestRaw<
    Parameters<typeof insertAutomatedFlowRunWithinCap>[0]["database"]
  >({
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      await run({
        execute: async (statement: SQL) => {
          entered.resolve(undefined);
          await proceed.promise;
          return aggregateExecutionRows(statement);
        },
        $count: async () => await Promise.resolve(0),
        insert: () => ({
          values: async (value: unknown) => {
            written.push(value);
          },
        }),
      }),
  });
  const result = insertAutomatedFlowRunWithinCap({
    definitionId,
    rows,
    database,
  });
  await entered.promise;
  rows.run.inputEntityIds?.push(createSafeId<"entity">());
  rows.steps.push({
    workspaceId: rows.run.workspaceId,
    runId,
    index: 1,
    kind: "review-gate",
  });
  proceed.resolve(undefined);
  expect(await result).toEqual({ outcome: "started" });
  expect(written.at(0)).toMatchObject({ inputEntityIds: [originalInput] });
  expect(written.at(1)).toHaveLength(1);
});
