/**
 * A workflow run reads its fields under its requester's current access, so a
 * requester who lost the matter or left the organization gets no model call,
 * no cell values and no successor run. Driven against a real (PGlite)
 * database; the run-state store, the model and the successor starter are
 * fakes, and the model and the starter panic unless a test opts in.
 *
 * The `workflow` and `workflow-flex` workers hand every job to the same
 * `processWorkflowEntityRun`; each case runs once per queue class.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  extractionRuns as extractionRunsTable,
  fields,
  properties,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { createSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import { createExtractionRunStore } from "@/api/lib/extraction-runs/store";
import type { ExtractionRunDb } from "@/api/lib/extraction-runs/store";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedExtractionRunId } from "@/api/lib/safe-id-boundaries";
import { processWorkflowEntityRun } from "@/api/lib/workflow-queue";
import * as batchGenerator from "@/api/lib/workflow/generate-batch-provider";
import type { ExecutionLevel } from "@/api/lib/workflow/get-execution-plan";
import { WORKFLOW_QUEUE_CLASSES } from "@/api/lib/workflow/queue-topology";
import * as rootRunStateStore from "@/api/lib/workflow/root-run-state-store";
import * as stragglerCatchUp from "@/api/lib/workflow/straggler-catchup";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const extractionRuns = createExtractionRunStore(
  asTestRaw<ExtractionRunDb>(testDb),
);

const originalOrganizationMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
const originalMatterMember = await testDb.query.workspaceMembers.findFirst({
  where: { id: { eq: ids.memberA1wsA1 } },
});
if (!originalOrganizationMember || !originalMatterMember) {
  panic("Workflow run fixture is incomplete");
}

const extractedPropertyId = createSafeId<"property">();
const extractedTool = {
  version: 1,
  type: "ai-model",
  prompt: "Governing law",
} as const;
await testDb.insert(properties).values({
  id: extractedPropertyId,
  workspaceId: ids.wsA1,
  name: "Governing law",
  content: { version: 1, type: "text" },
  tool: extractedTool,
  status: "stale",
});

const executionPlan: ExecutionLevel[] = [
  [
    {
      id: "batch-1",
      inputs: [],
      properties: [
        {
          id: extractedPropertyId,
          status: "stale",
          content: { version: 1, type: "text" },
          tool: extractedTool,
          dependencies: [],
        },
      ],
    },
  ],
];

const EXTRACTED_VALUE = "Laws of England and Wales";

const settingsSpy = spyOn(aiConfigLoader, "loadOrgAISettings");
type BatchGenerator = ReturnType<typeof batchGenerator.getBatchGenerator>;

const generateSpy = mock<BatchGenerator>();
const generatorSpy = spyOn(batchGenerator, "getBatchGenerator");
const stragglerSpy = spyOn(stragglerCatchUp, "startStragglerCatchUp");
const runStateSpy = spyOn(rootRunStateStore, "getRootWorkflowRunStateStore");
const clearedWorkspaceIds: string[] = [];
const createdRunIds: string[] = [];

beforeEach(() => {
  settingsSpy.mockReset();
  generateSpy.mockReset();
  generatorSpy.mockReset();
  stragglerSpy.mockReset();
  runStateSpy.mockReset();
  clearedWorkspaceIds.length = 0;
  settingsSpy.mockImplementation(async () =>
    Result.ok({
      orgAIConfig: null,
      promptCachingEnabled: false,
      managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
    }),
  );
  // Reaching the model or a successor start is a failure unless a test opts
  // in, so a stop that happens later than it should cannot pass unnoticed.
  generateSpy.mockImplementation(() =>
    panic("the model must not be called for this run"),
  );
  generatorSpy.mockImplementation(() => generateSpy);
  stragglerSpy.mockImplementation(() =>
    panic("no successor run may start for this run"),
  );
});

afterEach(async () => {
  await testDb.delete(fields).where(eq(fields.propertyId, extractedPropertyId));
  for (const runId of createdRunIds.splice(0)) {
    // db-await-in-loop: test cleanup of at most one run per test.
    await testDb
      .delete(extractionRunsTable)
      .where(eq(extractionRunsTable.id, brandPersistedExtractionRunId(runId)));
  }
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMember)
    .onConflictDoNothing();
});

afterAll(async () => {
  settingsSpy.mockRestore();
  generatorSpy.mockRestore();
  stragglerSpy.mockRestore();
  runStateSpy.mockRestore();
  await testDb.delete(properties).where(eq(properties.id, extractedPropertyId));
  await releaseRlsFixture();
});

/** A queued run of one entity whose completion finalizes the run. */
const queueRun = async (
  serviceTier: "standard" | "flex",
  plan: ExecutionLevel[] = executionPlan,
) => {
  const runId = createSafeId<"extractionRun">();
  createdRunIds.push(runId);
  const runKey = { id: runId, organizationId: ids.orgA, workspaceId: ids.wsA1 };
  await extractionRuns.create({
    ...runKey,
    requestedBy: ids.userA1,
    scope: "entities",
  });
  await extractionRuns.start({ ...runKey, total: 1 });
  runStateSpy.mockImplementation(() =>
    asTestRaw<
      ReturnType<typeof rootRunStateStore.getRootWorkflowRunStateStore>
    >({
      isCurrentRequest: async ({ requestId }: { requestId: string }) =>
        await Promise.resolve(requestId === runId),
      recordEntityCompletion: async () =>
        await Promise.resolve({ matched: true, completed: 1, total: 1 }),
      readFinalizationState: async () =>
        await Promise.resolve(
          Result.ok({
            status: "available",
            manifest: {
              version: 1,
              requestId: runId,
              freshnessScope: "cells",
              propertyIds: [extractedPropertyId],
              serviceTier,
            },
          }),
        ),
      clear: async (workspaceId: string) => {
        clearedWorkspaceIds.push(workspaceId);
        await Promise.resolve();
      },
    }),
  );
  const actor = createRootRunActor(
    {
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      runId,
    },
    brandPersistedExtractionRunId,
    database,
  );
  const run = async () =>
    await processWorkflowEntityRun({
      actor,
      admission: testModelAdmission(actor.organizationId),
      data: {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        entityId: ids.entityA1,
        executionPlan: plan,
        requestId: runId,
        serviceTier,
      },
      signal: new AbortController().signal,
      extractionRuns,
    });
  return { actor, run, runId };
};

const readRun = async (runId: string) => {
  const [run] = await testDb
    .select()
    .from(extractionRunsTable)
    .where(eq(extractionRunsTable.id, brandPersistedExtractionRunId(runId)))
    .limit(1);
  return run;
};

const readCells = async () =>
  await testDb
    .select({ content: fields.content })
    .from(fields)
    .where(
      and(
        eq(fields.propertyId, extractedPropertyId),
        eq(fields.entityVersionId, ids.entityVersionA1),
      ),
    );

const expectStoppedBeforeReading = async (serviceTier: "standard" | "flex") => {
  const { run, runId } = await queueRun(serviceTier);
  await run();
  expect(await readRun(runId)).toMatchObject({
    status: "failed",
    errorCode: "ExtractionRunInputsUnavailable",
  });
  expect((await readRun(runId))?.finishedAt).not.toBeNull();
  expect(await readCells()).toEqual([]);
  expect(generateSpy).not.toHaveBeenCalled();
  expect(stragglerSpy).not.toHaveBeenCalled();
  expect(clearedWorkspaceIds).toEqual([ids.wsA1]);
};

describe.each(WORKFLOW_QUEUE_CLASSES)("%s queue class", (queueClass) => {
  const serviceTier = queueClass;

  test("a run resolves its inputs while its requester keeps access", async () => {
    const { actor, run, runId } = await queueRun(serviceTier);
    generateSpy.mockImplementation(async ({ batch }) => {
      await Promise.resolve();
      return Result.ok({
        aiResults: batch.properties.map((property) => ({
          fieldId: createSafeId<"field">(),
          propertyId: property.id,
          content: { version: 1, type: "text", value: EXTRACTED_VALUE },
        })),
        aiJustifications: [],
        skippedPropertyIds: [],
        unsupportedPropertyIds: [],
      });
    });
    stragglerSpy.mockImplementation(async () => {
      await Promise.resolve();
    });

    await run();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const [generateOptions] = generateSpy.mock.calls.at(0) ?? [];
    expect(generateOptions?.scopedDb).toBe(actor.inputDb);
    expect(generateOptions?.entityVersionId).toBe(ids.entityVersionA1);
    expect(await readCells()).toEqual([
      { content: { version: 1, type: "text", value: EXTRACTED_VALUE } },
    ]);
    expect(await readRun(runId)).toMatchObject({ status: "completed" });
    // The successor run starts as the same requester and plans through the
    // requester's current access.
    expect(stragglerSpy).toHaveBeenCalledTimes(1);
    expect(stragglerSpy.mock.calls.at(0)?.at(0)).toMatchObject({
      userId: ids.userA1,
      scopedDb: actor.inputDb,
    });
  });

  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));
    await expectStoppedBeforeReading(serviceTier);
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    await expectStoppedBeforeReading(serviceTier);
  });

  test("a later level stops when access is removed during an earlier one", async () => {
    const level = executionPlan.at(0) ?? panic("execution plan has a level");
    const { run, runId } = await queueRun(serviceTier, [level, level]);
    generateSpy.mockImplementation(async ({ batch }) => {
      await testDb
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, ids.memberA1wsA1));
      return Result.ok({
        aiResults: batch.properties.map((property) => ({
          fieldId: createSafeId<"field">(),
          propertyId: property.id,
          content: { version: 1, type: "text", value: EXTRACTED_VALUE },
        })),
        aiJustifications: [],
        skippedPropertyIds: [],
        unsupportedPropertyIds: [],
      });
    });

    await run();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "ExtractionRunInputsUnavailable",
    });
    expect(stragglerSpy).not.toHaveBeenCalled();
  });
});
