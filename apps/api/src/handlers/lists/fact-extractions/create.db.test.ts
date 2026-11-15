/**
 * Starting a fact extraction: the AI admission settles before any document
 * is read, every document must be a readable one in the matter, and the run
 * counts against the organization's list AI run budget it shares with
 * verifications, so a full budget refuses the start without queuing a run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  legalListGenerationRuns,
  legalLists,
  modelRunBudgets,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createFactExtraction from "./create";

const testState = createTestState({ file: import.meta.path, config: env });
const clock = createTestClock();
let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(
  `fact-extraction-start-${Bun.randomUUIDv7()}`,
);
const userId = toSafeId<"user">(`fact-extraction-user-${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const otherWorkspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
let documentId: SafeId<"entity">;
let otherDocumentId: SafeId<"entity">;

/** A document with one DOCX file field, as its current version. */
const seedDocument = async (inWorkspace: SafeId<"workspace">) => {
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: inWorkspace,
    kind: "document",
    name: "Witness statement",
  });
  await testDb.insert(entityVersions).values({
    id: versionId,
    entityId,
    workspaceId: inWorkspace,
    versionNumber: 1,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId: inWorkspace,
    name: "File",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await testDb.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId: inWorkspace,
    entityVersionId: versionId,
    propertyId,
    content: {
      version: 1,
      type: "file",
      id: Bun.randomUUIDv7(),
      fileName: "statement.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 1024,
      encrypted: false,
      sha256Hex: "a".repeat(64),
      pdfFileId: null,
    },
  });
  return entityId;
};

testState.beforeAll(async () => {
  testDb = await getTestDb();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Fact extraction start",
    slug: organizationId,
    createdAt: new Date(clock.now()),
  });
  await testDb.insert(user).values({
    id: userId,
    name: "Fact extraction requester",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await testDb.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(clock.now()),
  });
  await testDb.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      name: "Fact extraction matter",
      reference: Bun.randomUUIDv7(),
    },
    {
      id: otherWorkspaceId,
      organizationId,
      name: "Another matter",
      reference: Bun.randomUUIDv7(),
    },
  ]);
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await testDb.insert(legalLists).values({
    id: listId,
    workspaceId,
    name: "Chronology",
    createdBy: userId,
  });
  documentId = await seedDocument(workspaceId);
  otherDocumentId = await seedDocument(otherWorkspaceId);
});

afterAll(async () => {
  await deleteOrganizationsForTest(testDb, [organizationId]);
  await releaseTestDb();
});

/** Restored after each test by the test state. */
const withListVerification = async (run: () => Promise<void>) => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId }],
    "list-verification": [{ type: "organization", organizationId }],
  });
  await run();
};

const start = async ({
  entityIds,
  orgAIConfigStatus = ORG_AI_CONFIG_STATUS.ok,
  onTransaction = () => undefined,
}: {
  entityIds: SafeId<"entity">[];
  orgAIConfigStatus?: OrgAIConfigStatus;
  onTransaction?: () => void;
}) => {
  const scoped = createSafeDb(testDb, [workspaceId], organizationId, userId);
  const safeDb: typeof scoped = async (operation) => {
    onTransaction();
    return await scoped(operation);
  };
  return await createFactExtraction.handler(
    createTestHandlerContext<
      Parameters<typeof createFactExtraction.handler>[0]
    >({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      workspaceId,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      safeDb,
      orgAIConfig: null,
      orgAIConfigStatus,
      modelAdmission: testModelAdmission(organizationId),
      body: { listId, entityIds },
    }),
  );
};

const statusOf = (result: unknown) =>
  result instanceof HttpStatusResponse ? result.code : null;

const activeRuns = async () =>
  (
    await testDb
      .select({ active: modelRunBudgets.activeRuns })
      .from(modelRunBudgets)
      .where(eq(modelRunBudgets.organizationId, organizationId))
  ).at(0)?.active ?? 0;

const runsOfList = async () =>
  await testDb.$count(
    legalListGenerationRuns,
    eq(legalListGenerationRuns.listId, listId),
  );

describe("starting a fact extraction", () => {
  test("an organization that must bring its own key is refused before any document is read", async () =>
    await withListVerification(async () => {
      let transactions = 0;
      const result = await start({
        entityIds: [documentId],
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ownKeyRequired,
        onTransaction: () => {
          transactions += 1;
        },
      });

      expect(statusOf(result)).toBe(403);
      // Only the identity and resource preflight ran; no document lookup.
      expect(transactions).toBe(2);
      expect(await runsOfList()).toBe(0);
    }));

  test("a document from another matter is not found and nothing is queued", async () =>
    await withListVerification(async () => {
      const result = await start({ entityIds: [documentId, otherDocumentId] });

      expect(statusOf(result)).toBe(404);
      expect(await runsOfList()).toBe(0);
    }));

  test("a full list AI run budget refuses the start without leaving a run", async () =>
    await withListVerification(async () => {
      // One run already holds a slot, and the cap is set to what is held.
      const holder = createSafeId<"legalListGenerationRun">();
      await testDb.insert(legalListGenerationRuns).values({
        id: holder,
        workspaceId,
        listId,
        organizationId,
        producer: "stella",
        itemType: "fact",
        status: "queued",
        instruction: "Hold a slot.",
        requestedBy: userId,
      });
      const held = await activeRuns();
      try {
        expect(held).toBe(1);
        testState.setConfig("LIST_VERIFICATION_ACTIVE_RUNS_MAX", held);
        testState.setConfig("LIST_VERIFICATION_DAILY_STARTS_MAX", 1000);

        const result = await start({ entityIds: [documentId] });

        expect(statusOf(result)).toBe(429);
        expect(
          result instanceof HttpStatusResponse ? result.response : null,
        ).toHaveProperty("code", "run_active_limit_reached");
        expect(await runsOfList()).toBe(1);
        expect(await activeRuns()).toBe(held);
      } finally {
        await testDb
          .delete(legalListGenerationRuns)
          .where(eq(legalListGenerationRuns.id, holder));
      }
      // A stella run's slot is released with it.
      expect(await activeRuns()).toBe(0);
    }));
});
