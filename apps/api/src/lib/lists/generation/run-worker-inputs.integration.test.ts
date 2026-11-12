/**
 * A fact extraction resolves its pinned documents under its requester's
 * current access, so nothing from a matter the requester can no longer open
 * is read. Driven against a real (PGlite) database; the document reader is a
 * fake that reports no text, which ends the run before any model call.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  legalListGenerationRuns,
  legalListGenerationSources,
  legalLists,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { processFactExtractionRun } from "@/api/lib/lists/generation/run-queue";
import type { FactExtractionExecutionBoundaries } from "@/api/lib/lists/generation/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedLegalListGenerationRunId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });
const clock = createTestClock();
let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(
  `fact-extraction-inputs-${Bun.randomUUIDv7()}`,
);
const userId = toSafeId<"user">(`fact-extraction-inputs-${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const documentId = createSafeId<"entity">();
const versionId = createSafeId<"entityVersion">();
const fileId = Bun.randomUUIDv7();
const organizationMemberId = Bun.randomUUIDv7();
const matterMemberId = createSafeId<"workspaceMember">();
let runId: SafeId<"legalListGenerationRun">;

testState.beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Fact extraction inputs",
    slug: organizationId,
    createdAt: new Date(clock.now()),
  });
  await testDb.insert(user).values({
    id: userId,
    name: "Fact extraction requester",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Fact extraction matter",
    reference: Bun.randomUUIDv7(),
  });
  await testDb.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: "Chronology",
    createdBy: userId,
  });
  const propertyId = createSafeId<"property">();
  await testDb.insert(entities).values({
    id: documentId,
    workspaceId,
    kind: "document",
    name: "Witness statement",
  });
  await testDb.insert(entityVersions).values({
    id: versionId,
    entityId: documentId,
    workspaceId,
    versionNumber: 1,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, documentId));
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await testDb.insert(fields).values({
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
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

beforeEach(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId }],
    "list-verification": [{ type: "organization", organizationId }],
  });
  await testDb.insert(member).values({
    id: organizationMemberId,
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
  await testDb
    .insert(workspaceMembers)
    .values({ id: matterMemberId, workspaceId, userId });
  runId = createSafeId<"legalListGenerationRun">();
  await testDb.insert(legalListGenerationRuns).values({
    id: runId,
    workspaceId,
    listId,
    organizationId,
    producer: "stella",
    itemType: "fact",
    status: "queued",
    instruction: "List every fact the documents establish.",
    requestedBy: userId,
  });
  await testDb.insert(legalListGenerationSources).values({
    id: createSafeId<"legalListGenerationSource">(),
    workspaceId,
    listId,
    runId,
    sourceEntityId: documentId,
    sourceEntityVersionId: versionId,
  });
});

afterEach(async () => {
  await testDb
    .delete(legalListGenerationRuns)
    .where(eq(legalListGenerationRuns.id, runId));
  await testDb
    .delete(workspaceMembers)
    .where(eq(workspaceMembers.id, matterMemberId));
  await testDb.delete(member).where(eq(member.id, organizationMemberId));
});

const run = async () => {
  const reads: string[] = [];
  const execution: FactExtractionExecutionBoundaries = {
    readDocument: async ({ file }) => {
      reads.push(file.fileId);
      return { type: "no-text" };
    },
  };
  await processFactExtractionRun({
    actor: createRootRunActor(
      { organizationId, workspaceId, userId, runId },
      brandPersistedLegalListGenerationRunId,
      asTestRaw<RlsDatabase<Transaction>>(testDb),
    ),
    admission: testModelAdmission(organizationId),
    data: { runId, organizationId, workspaceId, userId },
    execution,
  });
  const persisted = (
    await testDb
      .select({
        status: legalListGenerationRuns.status,
        errorCode: legalListGenerationRuns.errorCode,
        completedAt: legalListGenerationRuns.completedAt,
      })
      .from(legalListGenerationRuns)
      .where(eq(legalListGenerationRuns.id, runId))
  ).at(0);
  return { reads, persisted };
};

const expectStoppedBeforeReading = async () => {
  const { reads, persisted } = await run();
  expect(persisted).toMatchObject({
    status: "failed",
    errorCode: "access_revoked",
  });
  expect(persisted?.completedAt).not.toBeNull();
  expect(reads).toEqual([]);
};

describe("fact extraction run", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, matterMemberId));
    await expectStoppedBeforeReading();
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, organizationMemberId));
    await expectStoppedBeforeReading();
  });

  test("a run reads its pinned document while its requester keeps access", async () => {
    const { reads, persisted } = await run();
    expect(persisted).toMatchObject({ status: "failed", errorCode: "no_text" });
    expect(reads).toEqual([fileId]);
  });
});
