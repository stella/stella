import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { createSafeDb } from "@/api/db/scoped";
import type { SafeDb } from "@/api/db/safe-db";
import {
  aiMemories,
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  chatMessages,
  chatThreadCompactions,
  chatThreads,
  desktopEditSessions,
  docxSuggestions,
  entities,
  entityDeletionCleanupRequests,
  entityVersions,
  expenses,
  fields,
  folioCollabRooms,
  properties,
  timeEntries,
  userFiles,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  reserveObjectCleanupIntent,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { createFileKey, createUserFileKey } from "@/api/lib/file-key";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import { cents } from "@/api/lib/money";
import { completeOrganizationDeletion } from "@/api/lib/organization-storage-teardown";
import { executeAuthorizedWorkspaceDeletion } from "@/api/lib/workspace-deletion";
import type { WorkspaceDeletionDatabase } from "@/api/lib/workspace-deletion";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type Fixture = {
  actorUserId: SafeId<"user">;
  contextThreadId: SafeId<"chatThread">;
  dataThreadId: SafeId<"chatThread">;
  derivedCompactionId: SafeId<"chatThreadCompaction">;
  derivedMemoryId: SafeId<"aiMemory">;
  derivedSuggestionId: SafeId<"docxSuggestion">;
  expectedDeletedKeys: string[];
  organizationId: SafeId<"organization">;
  otherUserId: SafeId<"user">;
  retainedAttachmentKey: string;
  retainedThreadId: SafeId<"chatThread">;
  retainedWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  targetFailedCleanupIntentId: SafeId<"pendingUpload">;
  targetUncertainWriterIntentId: SafeId<"pendingUpload">;
  targetWriterIntentId: SafeId<"pendingUpload">;
};

let testDb: TestDatabase;
let fixture: Fixture;
let writerSafeDb: SafeDb;

const seedUser = async (name: string) => {
  const id = mintAuthProviderId<"user">();
  await testDb.insert(user).values({
    id,
    name,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
};

const seedDocument = async (workspaceId: SafeId<"workspace">) => {
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const propertyId = createSafeId<"property">();
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Document",
  });
  await testDb.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId,
    entityId,
  });
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "File",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
  });
  return { entityId, entityVersionId, propertyId };
};

const seedThreadFile = async ({
  dataWorkspaceIds = [],
  organizationId,
  userId,
  workspaceId,
}: {
  dataWorkspaceIds?: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const threadId = createSafeId<"chatThread">();
  const fileId = createSafeId<"userFile">();
  const s3Key = createUserFileKey({ fileId, mimeType: PDF_MIME_TYPE, userId });
  await testDb.insert(chatThreads).values({
    id: threadId,
    dataWorkspaceIds,
    organizationId,
    title: "Thread",
    userId,
    workspaceId,
  });
  await testDb.insert(userFiles).values({
    id: fileId,
    fileName: "attachment.pdf",
    mimeType: PDF_MIME_TYPE,
    s3Key,
    sha256Hex: "a".repeat(64),
    sizeBytes: 10,
    threadId,
    userId,
  });
  return { s3Key, threadId };
};

beforeAll(async () => {
  testDb = await getTestDb();
  const actorUserId = await seedUser("Deletion actor");
  const otherUserId = await seedUser("Other member");
  const organizationId = mintAuthProviderId<"organization">();
  const targetWorkspaceId = createSafeId<"workspace">();
  const retainedWorkspaceId = createSafeId<"workspace">();

  await testDb.insert(organization).values({
    id: organizationId,
    name: "Workspace deletion fixture",
    slug: `workspace-deletion-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values([
    {
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: actorUserId,
      role: "member",
      lastActiveWorkspaceId: targetWorkspaceId,
      createdAt: new Date(),
    },
    {
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: otherUserId,
      role: "member",
      lastActiveWorkspaceId: targetWorkspaceId,
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(workspaces).values([
    {
      id: targetWorkspaceId,
      organizationId,
      name: "Deleted matter",
      reference: "DEL-1",
      status: "active",
    },
    {
      id: retainedWorkspaceId,
      organizationId,
      name: "Retained matter",
      reference: "KEEP-1",
      status: "active",
    },
  ]);
  await testDb.insert(workspaceMembers).values([
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: targetWorkspaceId,
      userId: actorUserId,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: targetWorkspaceId,
      userId: otherUserId,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: retainedWorkspaceId,
      userId: actorUserId,
    },
  ]);
  writerSafeDb = asTestRaw<SafeDb>(
    createSafeDb(
      testDb,
      [targetWorkspaceId, retainedWorkspaceId],
      organizationId,
      actorUserId,
    ),
  );
  const reserveTargetWriter = async (suffix: string) => {
    const intent = await reserveObjectCleanupIntent({
      objectKey: `${organizationId}/${targetWorkspaceId}/${suffix}`,
      organizationId,
      safeDb: writerSafeDb,
      workspaceId: targetWorkspaceId,
    });
    if (Result.isError(intent)) {
      throw intent.error;
    }
    return intent.value;
  };
  const targetWriterIntentId = await reserveTargetWriter("late-target-object");
  const targetFailedCleanupIntentId = await reserveTargetWriter(
    "failed-cleanup-object",
  );
  const targetUncertainWriterIntentId = await reserveTargetWriter(
    "uncertain-write-object",
  );
  await testDb.insert(bufferObjectCleanupIntents).values({
    id: createSafeId<"pendingUpload">(),
    objectKey: `${organizationId}/${retainedWorkspaceId}/late-retained-object`,
    organizationId,
    status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
    workspaceId: retainedWorkspaceId,
  });

  const targetDocument = await seedDocument(targetWorkspaceId);
  const sourceFileId = Bun.randomUUIDv7();
  const pdfFileId = Bun.randomUUIDv7();
  const thumbnailFileId = Bun.randomUUIDv7();
  await testDb.insert(fields).values({
    id: createSafeId<"field">(),
    workspaceId: targetWorkspaceId,
    propertyId: targetDocument.propertyId,
    entityVersionId: targetDocument.entityVersionId,
    content: {
      type: "file",
      version: 1,
      id: sourceFileId,
      fileName: "source.docx",
      mimeType: DOCX_MIME_TYPE,
      sizeBytes: 10,
      encrypted: false,
      sha256Hex: "b".repeat(64),
      pdfFileId,
      thumbnailFileId,
    },
  });
  await testDb.insert(timeEntries).values({
    id: createSafeId<"timeEntry">(),
    organizationId,
    workspaceId: targetWorkspaceId,
    userId: actorUserId,
    workItemId: targetDocument.entityId,
    dateWorked: "2026-08-30",
    timezoneId: "Europe/Prague",
    durationMinutes: 30,
    billedMinutes: 30,
    rateAtEntry: cents(100),
    currency: "EUR",
    narrative: "Ordinary matter work",
  });
  await testDb.insert(expenses).values({
    id: createSafeId<"expense">(),
    organizationId,
    workspaceId: targetWorkspaceId,
    userId: actorUserId,
    matterId: targetDocument.entityId,
    dateIncurred: "2026-08-30",
    amount: cents(100),
    currency: "EUR",
    category: "filing_fee",
    description: "Ordinary matter expense",
  });

  const checkpointFileId = createSafeId<"userFile">();
  await testDb.insert(desktopEditSessions).values({
    id: createSafeId<"desktopEditSession">(),
    workspaceId: targetWorkspaceId,
    entityId: targetDocument.entityId,
    propertyId: targetDocument.propertyId,
    baseVersionId: targetDocument.entityVersionId,
    createdBy: actorUserId,
    fileType: "docx",
    fileName: "source.docx",
    checkpointFileId,
    sessionTokenHash: "c".repeat(64),
    tokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const yjsSnapshotFileId = createSafeId<"userFile">();
  const docxCheckpointFileId = createSafeId<"userFile">();
  await testDb.insert(folioCollabRooms).values({
    id: createSafeId<"folioCollabRoom">(),
    workspaceId: targetWorkspaceId,
    entityId: targetDocument.entityId,
    propertyId: targetDocument.propertyId,
    baseVersionId: targetDocument.entityVersionId,
    fileName: "source.docx",
    yjsSnapshotFileId,
    docxCheckpointFileId,
  });

  const actorThread = await seedThreadFile({
    organizationId,
    userId: actorUserId,
    workspaceId: targetWorkspaceId,
  });
  const otherThread = await seedThreadFile({
    organizationId,
    userId: otherUserId,
    workspaceId: targetWorkspaceId,
  });
  const dataThread = await seedThreadFile({
    dataWorkspaceIds: [targetWorkspaceId, retainedWorkspaceId],
    organizationId,
    userId: actorUserId,
    workspaceId: null,
  });
  const contextThreadId = createSafeId<"chatThread">();
  await testDb.insert(chatThreads).values({
    id: contextThreadId,
    contextMatterIds: [targetWorkspaceId],
    organizationId,
    title: "Context-only thread",
    userId: actorUserId,
  });
  const retainedThread = await seedThreadFile({
    organizationId,
    userId: actorUserId,
    workspaceId: retainedWorkspaceId,
  });
  const retainedMessageId = createSafeId<"chatMessage">();
  await testDb.insert(chatMessages).values({
    content: { data: [{ text: "Retained chat", type: "text" }], version: 1 },
    id: retainedMessageId,
    role: "user",
    threadId: retainedThread.threadId,
    userId: actorUserId,
    workspaceId: retainedWorkspaceId,
  });
  const derivedCompactionId = createSafeId<"chatThreadCompaction">();
  await testDb.insert(chatThreadCompactions).values({
    firstKeptMessageId: retainedMessageId,
    firstSummarizedMessageId: retainedMessageId,
    id: derivedCompactionId,
    lastSummarizedMessageId: retainedMessageId,
    memoryExtractionDataWorkspaceIds: [targetWorkspaceId],
    preservedTokens: 1,
    promptVersion: 1,
    status: "stale",
    summary: {
      blocked: [],
      constraints: [],
      criticalContext: [],
      done: [],
      goal: "Retained chat",
      inProgress: [],
      keyDecisions: [],
      modifiedFiles: [],
      nextSteps: [],
      readFiles: [],
      version: 1,
    },
    summaryMarkdown: "Retained chat",
    summarizedMessageCount: 1,
    threadId: retainedThread.threadId,
    totalSummarizedMessageCount: 1,
    totalTokens: 1,
  });

  const retainedDocument = await seedDocument(retainedWorkspaceId);
  const derivedMemoryId = createSafeId<"aiMemory">();
  await testDb.insert(aiMemories).values({
    id: derivedMemoryId,
    organizationId,
    scope: "user",
    userId: actorUserId,
    kind: "instruction",
    content: "Derived matter content",
    dedupKey: "d".repeat(64),
    source: "extracted",
    sourceDataWorkspaceIds: [targetWorkspaceId],
  });
  const derivedSuggestionId = createSafeId<"docxSuggestion">();
  await testDb.insert(docxSuggestions).values({
    id: derivedSuggestionId,
    workspaceId: retainedWorkspaceId,
    entityId: retainedDocument.entityId,
    sourceDataWorkspaceIds: [targetWorkspaceId],
    opPayload: {
      id: "derived-suggestion",
      type: "replaceInBlock",
      blockId: "block-1",
      find: "before",
      replace: "after",
    },
    severity: "medium",
    area: "body",
  });

  fixture = {
    actorUserId,
    contextThreadId,
    dataThreadId: dataThread.threadId,
    derivedCompactionId,
    derivedMemoryId,
    derivedSuggestionId,
    expectedDeletedKeys: [
      actorThread.s3Key,
      otherThread.s3Key,
      dataThread.s3Key,
      createFileKey({
        fileId: sourceFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
      createFileKey({
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
      createFileKey({
        fileId: thumbnailFileId,
        mimeType: "image/webp",
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
      createFileKey({
        fileId: checkpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
      createFileKey({
        fileId: yjsSnapshotFileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
      createFileKey({
        fileId: docxCheckpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId,
        workspaceId: targetWorkspaceId,
      }),
    ].sort(),
    organizationId,
    otherUserId,
    retainedAttachmentKey: retainedThread.s3Key,
    retainedThreadId: retainedThread.threadId,
    retainedWorkspaceId,
    targetWorkspaceId,
    targetFailedCleanupIntentId,
    targetUncertainWriterIntentId,
    targetWriterIntentId,
  };
});

afterAll(async () => {
  await testDb.transaction(
    async (tx) =>
      await completeOrganizationDeletion({
        organizationId: fixture.organizationId,
        tx: asTestRaw<Transaction>(tx),
      }),
  );
  await testDb
    .delete(entityDeletionCleanupRequests)
    .where(
      eq(entityDeletionCleanupRequests.organizationId, fixture.organizationId),
    );
  await testDb
    .delete(bufferObjectCleanupIntents)
    .where(
      eq(bufferObjectCleanupIntents.organizationId, fixture.organizationId),
    );
  await testDb
    .delete(user)
    .where(inArray(user.id, [fixture.actorUserId, fixture.otherUserId]));
  await releaseTestDb();
});

describe("workspace deletion", () => {
  test("atomically removes the complete target while preserving unrelated chats", async () => {
    const [compactionBefore, threadBefore] = await Promise.all([
      testDb
        .select({
          workspaceIds:
            chatThreadCompactions.memoryExtractionDataWorkspaceIds,
        })
        .from(chatThreadCompactions)
        .where(eq(chatThreadCompactions.id, fixture.derivedCompactionId)),
      testDb
        .select({
          dataWorkspaceIds: chatThreads.dataWorkspaceIds,
          workspaceId: chatThreads.workspaceId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, fixture.retainedThreadId)),
    ]);
    expect(compactionBefore).toEqual([
      { workspaceIds: [fixture.targetWorkspaceId] },
    ]);
    expect(threadBefore).toEqual([
      { dataWorkspaceIds: [], workspaceId: fixture.retainedWorkspaceId },
    ]);

    const auditEvents: AuditEvent[] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      auditEvents.push(...(Array.isArray(event) ? event : [event]));
    };
    const database: WorkspaceDeletionDatabase = {
      transaction: async (callback) =>
        await testDb.transaction(
          async (tx) => await callback(asTestRaw<Transaction>(tx)),
        ),
    };
    const result = await executeAuthorizedWorkspaceDeletion(
      {
        actorUserId: fixture.actorUserId,
        organizationId: fixture.organizationId,
        recordAuditEvent,
        workspaceId: fixture.targetWorkspaceId,
      },
      { database, enqueueCleanup: async () => {} },
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ status: "deleted" });
    }
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents.at(0)?.changes?.["deleted"]?.old).toMatchObject({
      id: fixture.targetWorkspaceId,
      status: "active",
    });
    expect(
      await testDb
        .select({ id: aiMemories.id })
        .from(aiMemories)
        .where(eq(aiMemories.id, fixture.derivedMemoryId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ status: bufferObjectCleanupIntents.status })
        .from(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.id, fixture.targetWriterIntentId)),
    ).toEqual([{ status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING }]);
    const settledWriter = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [fixture.targetWriterIntentId],
      objectState: "object-deleted",
      safeDb: writerSafeDb,
    });
    expect(Result.isOk(settledWriter)).toBe(true);
    expect(
      await testDb
        .select({ id: bufferObjectCleanupIntents.id })
        .from(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.id, fixture.targetWriterIntentId)),
    ).toEqual([]);
    const duplicateSettlement = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [fixture.targetWriterIntentId],
      objectState: "object-deleted",
      safeDb: writerSafeDb,
    });
    expect(Result.isError(duplicateSettlement)).toBe(true);
    const failedCleanup = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [fixture.targetFailedCleanupIntentId],
      objectState: "cleanup-required",
      safeDb: writerSafeDb,
    });
    const uncertainWrite = await settleObjectCleanupIntentsAfterWriter({
      intentIds: [fixture.targetUncertainWriterIntentId],
      objectState: "write-uncertain",
      safeDb: writerSafeDb,
    });
    expect(Result.isOk(failedCleanup)).toBe(true);
    expect(Result.isOk(uncertainWrite)).toBe(true);
    expect(
      await testDb
        .select({
          id: bufferObjectCleanupIntents.id,
          status: bufferObjectCleanupIntents.status,
        })
        .from(bufferObjectCleanupIntents)
        .where(
          inArray(bufferObjectCleanupIntents.id, [
            fixture.targetFailedCleanupIntentId,
            fixture.targetUncertainWriterIntentId,
          ]),
        ),
    ).toEqual(
      expect.arrayContaining([
        {
          id: fixture.targetFailedCleanupIntentId,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
        },
        {
          id: fixture.targetUncertainWriterIntentId,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
        },
      ]),
    );
    expect(
      await testDb
        .select({ status: bufferObjectCleanupIntents.status })
        .from(bufferObjectCleanupIntents)
        .where(
          eq(
            bufferObjectCleanupIntents.workspaceId,
            fixture.retainedWorkspaceId,
          ),
        ),
    ).toEqual([{ status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING }]);
    expect(
      await testDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, fixture.targetWorkspaceId)),
    ).toEqual([]);

    const cleanupRows = await testDb
      .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
      .from(entityDeletionCleanupRequests)
      .where(
        eq(
          entityDeletionCleanupRequests.workspaceId,
          fixture.targetWorkspaceId,
        ),
      );
    expect(cleanupRows.flatMap(({ s3Keys }) => s3Keys).sort()).toEqual(
      fixture.expectedDeletedKeys,
    );
    expect(
      await testDb
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, fixture.dataThreadId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ contextMatterIds: chatThreads.contextMatterIds })
        .from(chatThreads)
        .where(eq(chatThreads.id, fixture.contextThreadId)),
    ).toEqual([{ contextMatterIds: [] }]);
    expect(
      await testDb
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, fixture.retainedThreadId)),
    ).toHaveLength(1);
    expect(
      await testDb
        .select({ id: chatThreadCompactions.id })
        .from(chatThreadCompactions)
        .where(eq(chatThreadCompactions.id, fixture.derivedCompactionId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, fixture.retainedThreadId)),
    ).toHaveLength(1);
    expect(
      await testDb
        .select({ s3Key: userFiles.s3Key })
        .from(userFiles)
        .where(eq(userFiles.s3Key, fixture.retainedAttachmentKey)),
    ).toEqual([{ s3Key: fixture.retainedAttachmentKey }]);
    expect(
      await testDb
        .select({ id: docxSuggestions.id })
        .from(docxSuggestions)
        .where(eq(docxSuggestions.id, fixture.derivedSuggestionId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ lastActiveWorkspaceId: member.lastActiveWorkspaceId })
        .from(member)
        .where(eq(member.organizationId, fixture.organizationId)),
    ).toEqual([
      { lastActiveWorkspaceId: null },
      { lastActiveWorkspaceId: null },
    ]);
  });

  test("rolls back the seal, outbox, and rows when the audit write fails", async () => {
    const workspaceId = createSafeId<"workspace">();
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId: fixture.organizationId,
      name: "Rollback matter",
      reference: "ROLLBACK-1",
      status: "active",
    });
    await testDb.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: fixture.actorUserId,
    });
    const attachment = await seedThreadFile({
      organizationId: fixture.organizationId,
      userId: fixture.actorUserId,
      workspaceId,
    });
    const writerIntentId = createSafeId<"pendingUpload">();
    await testDb.insert(bufferObjectCleanupIntents).values({
      id: writerIntentId,
      objectKey: `${fixture.organizationId}/${workspaceId}/rollback-object`,
      organizationId: fixture.organizationId,
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
      workspaceId,
    });
    const database: WorkspaceDeletionDatabase = {
      transaction: async (callback) =>
        await testDb.transaction(
          async (tx) => await callback(asTestRaw<Transaction>(tx)),
        ),
    };
    const auditFailure = new Error("audit unavailable");
    const recordAuditEvent: AuditRecorder = async () => {
      throw auditFailure;
    };

    const result = await executeAuthorizedWorkspaceDeletion(
      {
        actorUserId: fixture.actorUserId,
        organizationId: fixture.organizationId,
        recordAuditEvent,
        workspaceId,
      },
      { database, enqueueCleanup: async () => {} },
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBe(auditFailure);
    }
    expect(
      await testDb
        .select({ status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId)),
    ).toEqual([{ status: "active" }]);
    expect(
      await testDb
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, attachment.threadId)),
    ).toHaveLength(1);
    expect(
      await testDb
        .select({ id: entityDeletionCleanupRequests.id })
        .from(entityDeletionCleanupRequests)
        .where(eq(entityDeletionCleanupRequests.workspaceId, workspaceId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ status: bufferObjectCleanupIntents.status })
        .from(bufferObjectCleanupIntents)
        .where(eq(bufferObjectCleanupIntents.id, writerIntentId)),
    ).toEqual([{ status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING }]);
  });
});
