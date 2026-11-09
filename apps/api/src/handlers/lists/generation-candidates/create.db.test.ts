import { Result } from "better-result";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH } from "@stll/api-contract/limits";
import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalListGenerationCandidates,
  legalListGenerationRuns,
  legalListGenerationSources,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import submitGenerationCandidates from "@/api/handlers/lists/generation-candidates/create";
import readGenerationCandidates from "@/api/handlers/lists/generation-candidates/list";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { ListGenerationProducer } from "@/api/lib/lists/generation/contract";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { TASK_NAME_MAX_LENGTH } from "@/api/lib/tasks/create-task-entity";
import { isRecord } from "@/api/lib/type-guards";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * An external producer submits candidates into a run it started. A fact
 * candidate may propose the fact details its item will carry once accepted;
 * the run's sources bound what it may cite, and a run stella produces takes
 * no submissions at all.
 */

type SubmitCandidates = typeof submitGenerationCandidates;
type SubmitCtx = Parameters<SubmitCandidates["handler"]>[0];
type ReadCandidatesCtx = Parameters<
  (typeof readGenerationCandidates)["handler"]
>[0];
type SubmitBody = v.InferInput<SubmitCandidates["config"]["body"]>;

// timeout: each test seeds an organization, its matter and a run through
// several round trips to the shared test database before it acts.
setDefaultTimeout(30_000);

let testDb: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });
const seededOrganizationIds: SafeId<"organization">[] = [];
const clock = createTestClock();

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testDb = await getTestDb();
});

afterAll(async () => {
  if (seededOrganizationIds.length > 0) {
    await deleteOrganizationsForTest(testDb, seededOrganizationIds);
  }
  await releaseTestDb();
});

const noAuditRows: AuditRecorder = async () => undefined;

const testSafeDb: SafeDb = async (fn) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        await tx.execute(
          sql`SELECT set_config('app.enabled_features', '["legal-lists"]', true)`,
        );
        return await fn(asTestRaw<Transaction>(tx));
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

type SeededRun = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
  runId: SafeId<"legalListGenerationRun">;
  documentId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

const seedRun = async (
  producer: ListGenerationProducer,
): Promise<SeededRun> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListGenerationRun">();
  const documentId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Candidate submission matter",
      slug: `candidate-submission-${Bun.randomUUIDv7()}`,
      createdAt: new Date(clock.now()),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Candidate Submission User",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await tx.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(clock.now()),
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Candidate submission matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      status: "active",
      createdBy: userId,
    });
    await tx.insert(entities).values({
      id: documentId,
      workspaceId,
      kind: "document",
      name: "Witness statement",
      createdBy: userId,
    });
    await tx.insert(entityVersions).values({
      id: versionId,
      workspaceId,
      entityId: documentId,
      versionNumber: 1,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, documentId));
    await tx.insert(legalListGenerationRuns).values({
      id: runId,
      workspaceId,
      listId,
      organizationId,
      producer,
      itemType: producer === "stella" ? "fact" : null,
      status: "running",
      instruction: "List the facts.",
      requestedBy: userId,
    });
    await tx.insert(legalListGenerationSources).values({
      id: createSafeId<"legalListGenerationSource">(),
      workspaceId,
      listId,
      runId,
      sourceEntityId: documentId,
      sourceEntityVersionId: versionId,
    });
  });
  seededOrganizationIds.push(organizationId);
  return {
    organizationId,
    userId,
    workspaceId,
    listId,
    runId,
    documentId,
    versionId,
  };
};

const submit = async (seeded: SeededRun, body: SubmitBody) =>
  await submitGenerationCandidates.handler(
    asTestRaw<SubmitCtx>({
      body: v.parse(submitGenerationCandidates.config.body, body),
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: noAuditRows,
      request: new Request(
        `https://example.test/v1/lists/${seeded.workspaceId}/generation-candidates`,
        { method: "POST" },
      ),
      route:
        "/v1/lists/:workspaceId/generation-candidates" satisfies ApiRoutePath,
      safeDb: testSafeDb,
      session: { activeOrganizationId: seeded.organizationId },
      user: { id: seeded.userId },
      workspaceId: seeded.workspaceId,
    }),
  );

const readCandidates = async (seeded: SeededRun) =>
  await readGenerationCandidates.handler(
    asTestRaw<ReadCandidatesCtx>({
      params: {
        workspaceId: seeded.workspaceId,
        listId: seeded.listId,
        runId: seeded.runId,
      },
      query: {},
      memberRole: sessionMemberRole("owner"),
      request: new Request(
        `https://example.test/v1/lists/${seeded.workspaceId}/${seeded.listId}/generations/${seeded.runId}/candidates`,
      ),
      route:
        "/v1/lists/:workspaceId/:listId/generations/:runId/candidates" satisfies ApiRoutePath,
      safeDb: testSafeDb,
      session: { activeOrganizationId: seeded.organizationId },
      user: { id: seeded.userId },
      workspaceId: seeded.workspaceId,
    }),
  );

const sourceOf = (seeded: SeededRun) => ({
  entityId: seeded.documentId,
  entityVersionId: seeded.versionId,
  locator: {
    type: "docx-block" as const,
    blockId: "b1",
    start: 0,
    end: 12,
  },
  quote: "The meeting.",
});

const factBody = (seeded: SeededRun): SubmitBody => ({
  listId: seeded.listId,
  runId: seeded.runId,
  candidates: [
    {
      name: "The board met in July 2021.",
      itemType: "fact",
      factDetails: {
        occurredOn: { date: "2021-07-19", precision: "month" },
        evidenceKind: "Testimony",
        medium: "Witness statement",
        confidence: "medium",
      },
      sources: [sourceOf(seeded)],
    },
    {
      name: "Prepare the chronology.",
      itemType: "task",
      sources: [sourceOf(seeded)],
    },
  ],
});

test("a submitted fact keeps its proposed details, and the listing returns them", async () => {
  const seeded = await seedRun("external");

  const submitted = await submit(seeded, factBody(seeded));
  expect(submitted).toMatchObject({ status: "review" });

  const rows = await testDb
    .select({
      itemType: legalListGenerationCandidates.itemType,
      occurredOn: legalListGenerationCandidates.occurredOn,
      occurredOnPrecision: legalListGenerationCandidates.occurredOnPrecision,
      evidenceKind: legalListGenerationCandidates.evidenceKind,
      scoring: legalListGenerationCandidates.scoring,
    })
    .from(legalListGenerationCandidates)
    .where(eq(legalListGenerationCandidates.runId, seeded.runId))
    .orderBy(legalListGenerationCandidates.position);
  // A month is stored as its first day, the spelling the item's row takes.
  expect(rows).toEqual([
    {
      itemType: "fact",
      occurredOn: "2021-07-01",
      occurredOnPrecision: "month",
      evidenceKind: "Testimony",
      scoring: null,
    },
    {
      itemType: "task",
      occurredOn: null,
      occurredOnPrecision: null,
      evidenceKind: null,
      scoring: null,
    },
  ]);

  const listed = await readCandidates(seeded);
  if (!isRecord(listed) || !Array.isArray(listed.items)) {
    throw new Error(`listing rejected: ${JSON.stringify(listed)}`);
  }
  expect(
    listed.items.map((item: unknown) => isRecord(item) && item["factDetails"]),
  ).toEqual([
    {
      occurredOn: { date: "2021-07-01", precision: "month" },
      evidenceKind: "Testimony",
      medium: "Witness statement",
      confidence: "medium",
      interpretationNote: null,
      scoring: null,
    },
    null,
  ]);
});

test("fact details on a candidate that is not a fact are refused", async () => {
  const seeded = await seedRun("external");

  const submitted = await submit(seeded, {
    listId: seeded.listId,
    runId: seeded.runId,
    candidates: [
      {
        name: "Prepare the chronology.",
        itemType: "task",
        factDetails: { confidence: "high" },
        sources: [sourceOf(seeded)],
      },
    ],
  });

  expect(submitted).toMatchObject({ code: 400 });
  expect(
    await testDb.$count(
      legalListGenerationCandidates,
      eq(legalListGenerationCandidates.runId, seeded.runId),
    ),
  ).toBe(0);
});

test("a run stella produces takes no submitted candidates", async () => {
  const seeded = await seedRun("stella");

  expect(await submit(seeded, factBody(seeded))).toMatchObject({ code: 409 });
  expect(
    await testDb.$count(
      legalListGenerationCandidates,
      eq(legalListGenerationCandidates.runId, seeded.runId),
    ),
  ).toBe(0);
});

test("a candidate name longer than a task name, or an over-long quote, is refused at submit", () => {
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListGenerationRun">();
  const source = {
    entityId: createSafeId<"entity">(),
    entityVersionId: createSafeId<"entityVersion">(),
    locator: { type: "document" },
  };
  const body = (name: string, quote: string) => ({
    listId,
    runId,
    candidates: [{ name, itemType: "fact", sources: [{ ...source, quote }] }],
  });
  const schema = submitGenerationCandidates.config.body;

  expect(v.is(schema, body("x".repeat(TASK_NAME_MAX_LENGTH), "q"))).toBe(true);
  expect(v.is(schema, body("x".repeat(TASK_NAME_MAX_LENGTH + 1), "q"))).toBe(
    false,
  );
  expect(
    v.is(schema, body("x", "q".repeat(LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH))),
  ).toBe(true);
  expect(
    v.is(schema, body("x", "q".repeat(LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH + 1))),
  ).toBe(false);
});
