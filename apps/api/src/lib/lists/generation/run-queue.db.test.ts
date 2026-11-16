/**
 * The fact extraction worker against a real database: it claims only queued
 * runs stella produces, reads the pinned documents, and leaves the facts it
 * found as candidates with their located sources for a person to review.
 * The document reader and the model are fakes, so nothing leaves the test.
 */

import { afterAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
  legalListGenerationSources,
  legalLists,
  modelRunBudgets,
  organizationSettings,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { ListGenerationProducer } from "@/api/lib/lists/generation/contract";
import { processFactExtractionRun } from "@/api/lib/lists/generation/run-queue";
import type { FactExtractionExecutionBoundaries } from "@/api/lib/lists/generation/run-queue";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedLegalListGenerationRunId } from "@/api/lib/safe-id-boundaries";
import type { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const clock = createTestClock();
const testState = createTestState({ file: import.meta.path, config: env });
let db: TestDatabase;
const organizationId = toSafeId<"organization">(
  `fact-extraction-${Bun.randomUUIDv7()}`,
);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const userId = toSafeId<"user">(`fact-requester-${Bun.randomUUIDv7()}`);
const grants = {
  [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
  [LIST_VERIFICATION_FEATURE_ID]: [{ type: "organization", organizationId }],
} satisfies FeatureAccessGrants;

testState.beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values({
    id: organizationId,
    name: "Fact extraction fixture",
    slug: organizationId,
    createdAt: new Date(clock.now()),
  });
  await db.insert(user).values({
    id: userId,
    name: "Fact requester",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Fact extraction matter",
    reference: Bun.randomUUIDv7(),
  });
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await db.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: "Chronology",
    createdBy: userId,
  });
  const configured = await encryptAIConfig(organizationId, {
    providers: [{ provider: "google", apiKey: "fixture-key" }],
    overrideModels: {
      chat: { provider: "google", modelId: "model-a" },
      fast: { provider: "google", modelId: "model-a" },
      pdf: { provider: "google", modelId: "model-a" },
      reasoning: { provider: "google", modelId: "model-a" },
    },
    decision: null,
  });
  await db.insert(organizationSettings).values({
    id: createSafeId<"organizationSettings">(),
    organizationId,
    aiConfigEncrypted: configured.ciphertext,
    aiConfigIv: configured.iv,
  });
});
afterAll(async () => await releaseTestDb());

/** Restored after each test by the test state. */
const withProductionPrerequisites = async (run: () => Promise<void>) => {
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", grants);
  // Runs these tests leave behind keep their slot; the supported upper
  // limits keep them from refusing the next one.
  testState.setConfig("LIST_VERIFICATION_ACTIVE_RUNS_MAX", 100);
  testState.setConfig("LIST_VERIFICATION_DAILY_STARTS_MAX", 1000);
  try {
    await run();
  } finally {
    restoreMode();
  }
};

/** A document with one DOCX file field, as its current version. */
const seedDocument = async () => {
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  const fileId = Bun.randomUUIDv7();
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Witness statement",
  });
  await db
    .insert(entityVersions)
    .values({ id: versionId, entityId, workspaceId, versionNumber: 1 });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  await db.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await db.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId,
    entityVersionId: versionId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "statement.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 1,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
  return { entityId, versionId, fileId };
};

const seedRun = async (producer: ListGenerationProducer) => {
  const document = await seedDocument();
  const runId = createSafeId<"legalListGenerationRun">();
  await db.insert(legalListGenerationRuns).values({
    id: runId,
    workspaceId,
    listId,
    organizationId,
    producer,
    itemType: producer === "stella" ? "fact" : null,
    status: producer === "stella" ? "queued" : "running",
    instruction: "Facts about the discharge policy",
    requestedBy: userId,
  });
  await db.insert(legalListGenerationSources).values({
    id: createSafeId<"legalListGenerationSource">(),
    workspaceId,
    listId,
    runId,
    sourceEntityId: document.entityId,
    sourceEntityVersionId: document.versionId,
  });
  return { runId, document };
};

const actorFor = (runId: SafeId<"legalListGenerationRun">) =>
  createRootRunActor(
    { organizationId, userId, workspaceId, runId },
    brandPersistedLegalListGenerationRunId,
    asTestRaw<RlsDatabase<Transaction>>(db),
  );

const BLOCKS: VerificationBlock[] = [
  {
    id: "b1",
    text: "On 9 March 2021 the board approved the discharge policy.",
    source: { type: "docx-block", blockId: "b1" },
  },
  {
    id: "b2",
    text: "I was told the “final” version was sent to every ward.",
    source: { type: "docx-block", blockId: "b2" },
  },
];

const ANSWER = {
  facts: [
    {
      blockId: "b1",
      quote: "the board approved the discharge policy",
      fact: "The board approved the discharge policy on 9 March 2021.",
      occurredOn: "2021-03-09",
      evidenceKind: "document",
      medium: "Board minutes",
      confidence: "high",
      contestedMeaning: null,
    },
    {
      blockId: "b2",
      quote: "the “final” version was sent to every ward",
      fact: "The final version of the policy was sent to every ward.",
      occurredOn: null,
      evidenceKind: "testimony",
      medium: "Witness statement",
      confidence: "medium",
      contestedMeaning:
        "“Final” may mean the approved policy or the last circulated draft.",
    },
  ],
};

const fakeExecution = (
  reads: string[],
  dispatches: unknown[],
): FactExtractionExecutionBoundaries => ({
  readDocument: async ({ file }) => {
    reads.push(file.fileId);
    return { type: "read", blocks: BLOCKS };
  },
  generateObjectForTask: asTestRaw<typeof generateTanStackObjectForTask>(
    async (request: unknown) => {
      dispatches.push(request);
      return ANSWER;
    },
  ),
});

const readRun = async (runId: SafeId<"legalListGenerationRun">) =>
  (
    await db
      .select({
        status: legalListGenerationRuns.status,
        errorCode: legalListGenerationRuns.errorCode,
      })
      .from(legalListGenerationRuns)
      .where(eq(legalListGenerationRuns.id, runId))
  ).at(0);

test("a queued run stella produces leaves its facts as candidates with located sources, once", async () =>
  await withProductionPrerequisites(async () => {
    const { runId, document } = await seedRun("stella");
    const reads: string[] = [];
    const dispatches: unknown[] = [];
    const args = {
      data: { runId, organizationId, workspaceId, userId },
      admission: testModelAdmission(organizationId),
      actor: actorFor(runId),
      grants,
      execution: fakeExecution(reads, dispatches),
    };

    await processFactExtractionRun(args);
    // A re-delivered job finds the run no longer queued and does nothing.
    await processFactExtractionRun(args);

    expect(reads).toEqual([document.fileId]);
    expect(dispatches).toHaveLength(1);
    expect(await readRun(runId)).toEqual({ status: "review", errorCode: null });
    // The run counted against the shared list AI budget while it ran and
    // released its slot once it went to review.
    expect(
      (
        await db
          .select({
            active: modelRunBudgets.activeRuns,
            starts: modelRunBudgets.startsToday,
          })
          .from(modelRunBudgets)
          .where(eq(modelRunBudgets.organizationId, organizationId))
      ).at(0),
    ).toEqual({ active: 0, starts: 1 });
    const candidates = await db
      .select({
        id: legalListGenerationCandidates.id,
        name: legalListGenerationCandidates.name,
        itemType: legalListGenerationCandidates.itemType,
        occurredOn: legalListGenerationCandidates.occurredOn,
        evidenceKind: legalListGenerationCandidates.evidenceKind,
        confidence: legalListGenerationCandidates.confidence,
        interpretationNote: legalListGenerationCandidates.interpretationNote,
        scoring: legalListGenerationCandidates.scoring,
        status: legalListGenerationCandidates.status,
      })
      .from(legalListGenerationCandidates)
      .where(eq(legalListGenerationCandidates.runId, runId))
      .orderBy(asc(legalListGenerationCandidates.position));
    expect(candidates.map(({ id: _id, ...candidate }) => candidate)).toEqual([
      {
        name: "The board approved the discharge policy on 9 March 2021.",
        itemType: "fact",
        occurredOn: "2021-03-09",
        evidenceKind: "Document",
        confidence: "high",
        interpretationNote: null,
        scoring: "included",
        status: "pending",
      },
      {
        name: "The final version of the policy was sent to every ward.",
        itemType: "fact",
        occurredOn: null,
        evidenceKind: "Testimony",
        confidence: "medium",
        interpretationNote:
          "“Final” may mean the approved policy or the last circulated draft.",
        scoring: "held",
        status: "pending",
      },
    ]);
    const sources = await db
      .select({
        candidateId: legalListGenerationCandidateSources.candidateId,
        sourceEntityVersionId:
          legalListGenerationCandidateSources.sourceEntityVersionId,
        locator: legalListGenerationCandidateSources.locator,
        quote: legalListGenerationCandidateSources.quote,
      })
      .from(legalListGenerationCandidateSources)
      .where(eq(legalListGenerationCandidateSources.runId, runId));
    expect(
      candidates.map((candidate) =>
        sources
          .filter((source) => source.candidateId === candidate.id)
          .map(({ candidateId: _candidateId, ...source }) => source),
      ),
    ).toEqual([
      [
        {
          sourceEntityVersionId: document.versionId,
          locator: { type: "docx-block", blockId: "b1", start: 16, end: 55 },
          quote: "the board approved the discharge policy",
        },
      ],
      [
        {
          sourceEntityVersionId: document.versionId,
          locator: { type: "docx-block", blockId: "b2", start: 11, end: 53 },
          quote: "the “final” version was sent to every ward",
        },
      ],
    ]);
    const audits = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, runId),
          eq(auditLogs.resourceType, "legal_list_generation"),
        ),
      );
    expect(audits).toHaveLength(1);
  }));

test("the worker never claims a run an external client produces", async () =>
  await withProductionPrerequisites(async () => {
    const { runId } = await seedRun("external");
    const reads: string[] = [];
    const dispatches: unknown[] = [];

    await processFactExtractionRun({
      data: { runId, organizationId, workspaceId, userId },
      admission: testModelAdmission(organizationId),
      actor: actorFor(runId),
      grants,
      execution: fakeExecution(reads, dispatches),
    });

    expect(reads).toHaveLength(0);
    expect(dispatches).toHaveLength(0);
    expect(await readRun(runId)).toEqual({
      status: "running",
      errorCode: null,
    });
    expect(
      await db.$count(
        legalListGenerationCandidates,
        eq(legalListGenerationCandidates.runId, runId),
      ),
    ).toBe(0);
  }));

test("a requester without the feature fails the run before any document is read", async () =>
  await withProductionPrerequisites(async () => {
    const { runId } = await seedRun("stella");
    const reads: string[] = [];
    const dispatches: unknown[] = [];

    await processFactExtractionRun({
      data: { runId, organizationId, workspaceId, userId },
      admission: testModelAdmission(organizationId),
      actor: actorFor(runId),
      grants: { [LEGAL_LISTS_FEATURE_ID]: grants[LEGAL_LISTS_FEATURE_ID] },
      execution: fakeExecution(reads, dispatches),
    });

    expect(reads).toHaveLength(0);
    expect(dispatches).toHaveLength(0);
    expect(await readRun(runId)).toEqual({
      status: "failed",
      errorCode: "access_revoked",
    });
  }));

test("a document with no text fails the run with that reason and no candidates", async () =>
  await withProductionPrerequisites(async () => {
    const { runId } = await seedRun("stella");
    const dispatches: unknown[] = [];

    await processFactExtractionRun({
      data: { runId, organizationId, workspaceId, userId },
      admission: testModelAdmission(organizationId),
      actor: actorFor(runId),
      grants,
      execution: {
        ...fakeExecution([], dispatches),
        readDocument: async () => ({ type: "no-text" }),
      },
    });

    expect(dispatches).toHaveLength(0);
    expect(await readRun(runId)).toEqual({
      status: "failed",
      errorCode: "no_text",
    });
  }));
