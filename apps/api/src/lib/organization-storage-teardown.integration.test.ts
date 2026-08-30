import { Result, panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  chatThreads,
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityDeletionCleanupRequests,
  entityVersions,
  fields,
  folioCollabRooms,
  pendingUploads,
  properties,
  styleSets,
  templateVersions,
  templates,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import type { PendingUploadPurposeData } from "@/api/db/schema";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockObjectCleanupIntentsForWriter,
  reserveObjectCleanupIntents,
} from "@/api/lib/buffer-intent-reconciliation";
import {
  completeOrganizationDeletion,
  OrganizationStorageTeardownBoundError,
} from "@/api/lib/organization-storage-teardown";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// ── Organization deletion clears the organization's stored objects ──────
//
// The fixture is production-shaped on purpose: every id is a UUIDv7 exactly as
// the application mints them, and every key below is built by the same helpers
// the writers use, so the assertions compare real keys rather than stand-ins a
// key builder would never produce.
//
// The second organization is the part that has to be right: the same person is
// a member of both and has a chat attachment in each. Chat attachment keys are
// minted from the user id, so a teardown that reasoned about the user instead
// of the thread would erase the other organization's attachment too.

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

const uuid = () => Bun.randomUUIDv7();

// Fixture literals that stand in for a producer's output are pinned against the
// producing type, so a value the domain does not actually have fails here, with
// the offending property named, instead of surfacing as an unresolved insert
// overload several lines away.
const FILE_PROPERTY_CONTENT = {
  version: 1,
  type: "file",
} as const satisfies PropertyContent;

const MANUAL_PROPERTY_TOOL = {
  version: 1,
  type: "manual-input",
} as const satisfies PropertyTool;

type Fixture = {
  chatAttachmentKey: string;
  chatThumbnailKey: string;
  checkpointKey: string;
  collabDocxKey: string;
  collabSnapshotKey: string;
  foreignOrganizationWriterRejected: boolean;
  globalChatAttachmentKey: string;
  ocrKey: string;
  organizationId: SafeId<"organization">;
  organizationWriterIntentId: SafeId<"pendingUpload">;
  organizationWriterKey: string;
  otherChatAttachmentKey: string;
  otherOrganizationId: SafeId<"organization">;
  otherTemplateKey: string;
  pdfKey: string;
  pendingFinalKey: string;
  pendingTmpKey: string;
  pendingUploadId: SafeId<"pendingUpload">;
  secondMatterSourceKey: string;
  sourceKey: string;
  styleSetKeys: string[];
  templateKeys: string[];
  thumbnailKey: string;
  userId: SafeId<"user">;
};

let testDb: TestDatabase;
let fixture: Fixture;

const seedOrganization = async ({
  name,
  organizationId,
  userId,
}: {
  name: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => {
  await testDb.insert(organization).values({
    id: organizationId,
    name,
    slug: `${name}-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values({
    id: uuid(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
};

const seedMatter = async ({
  organizationId,
  reference,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  reference: string;
  workspaceId: SafeId<"workspace">;
}) => {
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: `Matter ${reference}`,
    reference,
    status: "active",
  });
};

const seedFileDocument = async ({
  fileId,
  pdfFileId,
  thumbnailFileId,
  workspaceId,
}: {
  fileId: string;
  pdfFileId: string | null;
  thumbnailFileId: string | null;
  workspaceId: SafeId<"workspace">;
}) => {
  const entityId = toSafeId<"entity">(uuid());
  const entityVersionId = toSafeId<"entityVersion">(uuid());
  const propertyId = toSafeId<"property">(uuid());
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Engagement letter",
  });
  await testDb.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId,
    entityId,
  });
  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId,
    name: "Source file",
    content: FILE_PROPERTY_CONTENT,
    tool: MANUAL_PROPERTY_TOOL,
    status: "fresh",
  });
  const fieldId = toSafeId<"field">(uuid());
  await testDb.insert(fields).values({
    id: fieldId,
    workspaceId,
    propertyId,
    entityVersionId,
    content: {
      version: 1,
      type: "file",
      id: fileId,
      fileName: "engagement-letter.docx",
      mimeType: DOCX_MIME,
      sizeBytes: 2048,
      encrypted: false,
      sha256Hex: "b".repeat(64),
      pdfFileId,
      thumbnailFileId,
    },
  });
  return { entityId, entityVersionId, fieldId, propertyId };
};

const seedChatAttachment = async ({
  organizationId,
  thumbnailFileId,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  thumbnailFileId: string | null;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const threadId = toSafeId<"chatThread">(uuid());
  const userFileId = toSafeId<"userFile">(uuid());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId,
    userId,
    title: "Attachment thread",
    workspaceId,
  });
  await testDb.insert(userFiles).values({
    id: userFileId,
    userId,
    fileName: "brief.pdf",
    mimeType: PDF_MIME,
    sizeBytes: 4096,
    sha256Hex: "c".repeat(64),
    s3Key: `${userId}/${userFileId}.pdf`,
    threadId,
    thumbnailFileId,
  });
  return { s3Key: `${userId}/${userFileId}.pdf`, threadId, userFileId };
};

beforeAll(async () => {
  testDb = await getTestDb();

  const organizationId = toSafeId<"organization">(uuid());
  const otherOrganizationId = toSafeId<"organization">(uuid());
  const userId = toSafeId<"user">(uuid());
  const workspaceIds = [
    toSafeId<"workspace">(uuid()),
    toSafeId<"workspace">(uuid()),
  ];
  const otherWorkspaceId = toSafeId<"workspace">(uuid());

  await testDb.insert(user).values({
    id: userId,
    name: "Teardown owner",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await seedOrganization({ name: "deleted", organizationId, userId });
  await seedOrganization({
    name: "retained",
    organizationId: otherOrganizationId,
    userId,
  });

  const [firstWorkspaceId, secondWorkspaceId] = workspaceIds;
  if (firstWorkspaceId === undefined || secondWorkspaceId === undefined) {
    throw new Error("fixture workspace ids are missing");
  }
  await seedMatter({
    organizationId,
    reference: "REF-1",
    workspaceId: firstWorkspaceId,
  });
  await seedMatter({
    organizationId,
    reference: "REF-2",
    workspaceId: secondWorkspaceId,
  });
  await seedMatter({
    organizationId: otherOrganizationId,
    reference: "REF-OTHER",
    workspaceId: otherWorkspaceId,
  });

  // Matter one: a document with a converted PDF and a thumbnail, an OCR run, a
  // desktop edit-session checkpoint, and a staged upload that never finalized.
  const fileId = uuid();
  const pdfFileId = uuid();
  const thumbnailFileId = uuid();
  const { entityId, entityVersionId, fieldId, propertyId } =
    await seedFileDocument({
      fileId,
      pdfFileId,
      thumbnailFileId,
      workspaceId: firstWorkspaceId,
    });

  const runId = toSafeId<"documentProcessingRun">(uuid());
  await testDb.insert(documentProcessingRuns).values({
    id: runId,
    organizationId,
    workspaceId: firstWorkspaceId,
    entityId,
    entityVersionId,
    fieldId,
    sourceFileId: fileId,
    sourceSha256Hex: "d".repeat(64),
    kind: "ocr",
    requestSource: "manual",
  });

  const checkpointFileId = toSafeId<"userFile">(uuid());
  await testDb.insert(desktopEditSessions).values({
    id: toSafeId<"desktopEditSession">(uuid()),
    workspaceId: firstWorkspaceId,
    entityId,
    propertyId,
    baseVersionId: entityVersionId,
    createdBy: userId,
    fileType: "docx",
    fileName: "engagement-letter.docx",
    checkpointFileId,
    sessionTokenHash: "e".repeat(64),
    tokenExpiresAt: new Date(Date.now() + 60_000),
  });

  const pendingUploadId = toSafeId<"pendingUpload">(uuid());
  const reservedFileId = uuid();
  await testDb.insert(pendingUploads).values({
    id: pendingUploadId,
    organizationId,
    workspaceId: firstWorkspaceId,
    userId,
    purpose: "entity_create",
    // `reservedFileId` is the field that makes this reservation recoverable:
    // it is the final key the writer had already claimed, and the teardown has
    // to record it even though the object may not exist yet.
    purposeData: {
      type: "entity_create",
      propertyId: toSafeId<"property">(uuid()),
      reservedFileId,
    } as const satisfies PendingUploadPurposeData,
    declaredName: "staged.docx",
    declaredMime: DOCX_MIME,
    declaredSize: 1024,
    declaredSha256: "f".repeat(64),
    status: "scanning",
    expiresAt: new Date(Date.now() + 60_000),
  });

  // Matter two: a collaborative editing room with both of its slots.
  const collabSnapshotFileId = toSafeId<"userFile">(uuid());
  const collabDocxFileId = toSafeId<"userFile">(uuid());
  const secondMatterFileId = uuid();
  const secondDocument = await seedFileDocument({
    fileId: secondMatterFileId,
    pdfFileId: null,
    thumbnailFileId: null,
    workspaceId: secondWorkspaceId,
  });
  await testDb.insert(folioCollabRooms).values({
    id: toSafeId<"folioCollabRoom">(uuid()),
    workspaceId: secondWorkspaceId,
    entityId: secondDocument.entityId,
    propertyId: secondDocument.propertyId,
    baseVersionId: secondDocument.entityVersionId,
    fileName: "engagement-letter.docx",
    yjsSnapshotFileId: collabSnapshotFileId,
    docxCheckpointFileId: collabDocxFileId,
  });

  // Organization-owned storage: a template with a version, and a style-set
  // package whose replacement left a superseded package behind.
  const templateId = toSafeId<"template">(uuid());
  const templateKey = `${organizationId}/templates/${templateId}/v2.docx`;
  await testDb.insert(templates).values({
    id: templateId,
    organizationId,
    name: "Engagement letter",
    fileName: "engagement-letter.docx",
    s3Key: templateKey,
    sizeBytes: 1024,
    createdBy: userId,
  });
  const templateVersionKey = `${organizationId}/templates/${templateId}/v1.docx`;
  await testDb.insert(templateVersions).values({
    id: toSafeId<"templateVersion">(uuid()),
    organizationId,
    templateId,
    version: 1,
    s3Key: templateVersionKey,
    createdBy: userId,
  });

  const styleSetId = toSafeId<"styleSet">(uuid());
  const styleSetKey = `${organizationId}/style-sets/${styleSetId}/${uuid()}.docx`;
  const supersededStyleSetKey = `${organizationId}/style-sets/${styleSetId}/${uuid()}.docx`;
  await testDb.insert(styleSets).values({
    id: styleSetId,
    organizationId,
    name: "House style",
    fileName: "house-style.docx",
    s3Key: styleSetKey,
    cleanupS3Key: supersededStyleSetKey,
    sizeBytes: 1024,
    createdBy: userId,
  });

  // The other organization holds a template and a chat attachment of its own.
  const otherTemplateId = toSafeId<"template">(uuid());
  const otherTemplateKey = `${otherOrganizationId}/templates/${otherTemplateId}.docx`;
  await testDb.insert(templates).values({
    id: otherTemplateId,
    organizationId: otherOrganizationId,
    name: "Retained template",
    fileName: "retained.docx",
    s3Key: otherTemplateKey,
    sizeBytes: 1024,
    createdBy: userId,
  });

  const chatThumbnailFileId = uuid();
  const attachment = await seedChatAttachment({
    organizationId,
    thumbnailFileId: chatThumbnailFileId,
    userId,
    workspaceId: firstWorkspaceId,
  });
  const globalAttachment = await seedChatAttachment({
    organizationId,
    thumbnailFileId: null,
    userId,
    workspaceId: null,
  });
  const otherAttachment = await seedChatAttachment({
    organizationId: otherOrganizationId,
    thumbnailFileId: null,
    userId,
    workspaceId: otherWorkspaceId,
  });
  const organizationWriterKey = `${userId}/${uuid()}.txt`;
  const scopedSafeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [], organizationId, userId),
  );
  const organizationWriterIntent = await reserveObjectCleanupIntents({
    chatThreadId: globalAttachment.threadId,
    objectKey: organizationWriterKey,
    organizationId,
    safeDb: scopedSafeDb,
    workspaceIds: [],
  });
  if (Result.isError(organizationWriterIntent)) {
    throw organizationWriterIntent.error;
  }
  const visibleThread = await scopedSafeDb(
    async (tx) =>
      await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, globalAttachment.threadId)),
  );
  if (Result.isError(visibleThread)) {
    throw visibleThread.error;
  }
  if (visibleThread.value.length !== 1) {
    panic("Organization-scoped chat thread is not visible to its writer");
  }
  const visibleIntent = await scopedSafeDb(
    async (tx) =>
      await tx
        .select({
          id: bufferObjectCleanupIntents.id,
          status: bufferObjectCleanupIntents.status,
        })
        .from(bufferObjectCleanupIntents)
        .where(
          eq(
            bufferObjectCleanupIntents.id,
            organizationWriterIntent.value.at(0) ??
              panic("Organization writer reservation returned no intent"),
          ),
        ),
  );
  if (Result.isError(visibleIntent)) {
    throw visibleIntent.error;
  }
  if (
    visibleIntent.value.at(0)?.status !==
    BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING
  ) {
    panic("Organization-scoped cleanup intent is not visible to its writer");
  }
  const writerLock = await scopedSafeDb(async (tx) => {
    await lockObjectCleanupIntentsForWriter(tx, organizationWriterIntent.value);
  });
  if (Result.isError(writerLock)) {
    throw writerLock.error;
  }
  const foreignOrganizationWriter = await reserveObjectCleanupIntents({
    chatThreadId: globalAttachment.threadId,
    objectKey: `another-user/${uuid()}.txt`,
    organizationId,
    safeDb: scopedSafeDb,
    workspaceIds: [],
  });

  fixture = {
    chatAttachmentKey: attachment.s3Key,
    chatThumbnailKey: `${userId}/${chatThumbnailFileId}.webp`,
    checkpointKey: `${organizationId}/${firstWorkspaceId}/${checkpointFileId}.docx`,
    collabDocxKey: `${organizationId}/${secondWorkspaceId}/${collabDocxFileId}.docx`,
    collabSnapshotKey: `${organizationId}/${secondWorkspaceId}/${collabSnapshotFileId}.bin`,
    foreignOrganizationWriterRejected: Result.isError(
      foreignOrganizationWriter,
    ),
    globalChatAttachmentKey: globalAttachment.s3Key,
    ocrKey: `${organizationId}/${firstWorkspaceId}/ocr/${runId}.pdf`,
    organizationId,
    organizationWriterIntentId:
      organizationWriterIntent.value.at(0) ??
      panic("Organization writer reservation returned no intent"),
    organizationWriterKey,
    otherChatAttachmentKey: otherAttachment.s3Key,
    otherOrganizationId,
    otherTemplateKey,
    pdfKey: `${organizationId}/${firstWorkspaceId}/${pdfFileId}.pdf`,
    pendingFinalKey: `${organizationId}/${firstWorkspaceId}/${reservedFileId}.docx`,
    pendingTmpKey: `${organizationId}/${firstWorkspaceId}/tmp/${pendingUploadId}`,
    pendingUploadId,
    secondMatterSourceKey: `${organizationId}/${secondWorkspaceId}/${secondMatterFileId}.docx`,
    sourceKey: `${organizationId}/${firstWorkspaceId}/${fileId}.docx`,
    styleSetKeys: [styleSetKey, supersededStyleSetKey],
    templateKeys: [templateKey, templateVersionKey],
    thumbnailKey: `${organizationId}/${firstWorkspaceId}/${thumbnailFileId}.webp`,
    userId,
  };

  await testDb.transaction(
    async (tx) =>
      await completeOrganizationDeletion({
        organizationId,
        tx: asTestRaw<Transaction>(tx),
      }),
  );
});

afterAll(async () => {
  await testDb
    .delete(entityDeletionCleanupRequests)
    .where(
      inArray(entityDeletionCleanupRequests.organizationId, [
        fixture.organizationId,
        fixture.otherOrganizationId,
      ]),
    );
  await testDb
    .delete(bufferObjectCleanupIntents)
    .where(
      eq(bufferObjectCleanupIntents.organizationId, fixture.organizationId),
    );
  // The organization that survives is torn down through the same helper, which
  // is also the only ordering `user_files.thread_id`'s RESTRICT admits.
  await testDb.transaction(
    async (tx) =>
      await completeOrganizationDeletion({
        organizationId: fixture.otherOrganizationId,
        tx: asTestRaw<Transaction>(tx),
      }),
  );
  await testDb
    .delete(entityDeletionCleanupRequests)
    .where(
      eq(
        entityDeletionCleanupRequests.organizationId,
        fixture.otherOrganizationId,
      ),
    );
  await testDb.delete(user).where(eq(user.id, fixture.userId));
  await releaseTestDb();
});

/**
 * A page names either the matter its keys sit under, or the organization for
 * the classes that never had a matter: templates, style-set packages, and chat
 * attachments. Staged uploads additionally carry the legacy `tmp/` key, which
 * predates the tenant prefix.
 */
const pageKeysMatchScope = ({
  s3Keys,
  workspaceId,
}: {
  s3Keys: string[];
  workspaceId: SafeId<"workspace"> | null;
}): boolean =>
  s3Keys.every((key) =>
    workspaceId === null
      ? key.startsWith(`${fixture.organizationId}/templates/`) ||
        key.startsWith(`${fixture.organizationId}/style-sets/`) ||
        key.startsWith(`${fixture.userId}/`)
      : key.startsWith(`${fixture.organizationId}/${workspaceId}/`) ||
        key.startsWith("tmp/"),
  );

const recordedKeys = async (
  organizationId: SafeId<"organization">,
): Promise<string[]> => {
  const rows = await testDb
    .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
    .from(entityDeletionCleanupRequests)
    .where(eq(entityDeletionCleanupRequests.organizationId, organizationId));
  return rows.flatMap(({ s3Keys }) => s3Keys).sort();
};

describe("organization deletion storage teardown", () => {
  test("organization-scoped writer ownership stays pinned to the user key", () => {
    expect(fixture.foreignOrganizationWriterRejected).toBe(true);
  });

  test("records every stored object the organization owns", async () => {
    // Declared set equals recorded set, in both directions: a storage class the
    // enumeration forgets fails here, and so does a key it invents.
    expect(await recordedKeys(fixture.organizationId)).toEqual(
      [
        fixture.chatAttachmentKey,
        fixture.chatThumbnailKey,
        fixture.checkpointKey,
        fixture.collabDocxKey,
        fixture.collabSnapshotKey,
        fixture.globalChatAttachmentKey,
        fixture.ocrKey,
        fixture.pdfKey,
        fixture.pendingFinalKey,
        fixture.pendingTmpKey,
        `tmp/${fixture.pendingUploadId}`,
        fixture.secondMatterSourceKey,
        fixture.sourceKey,
        ...fixture.styleSetKeys,
        ...fixture.templateKeys,
        fixture.thumbnailKey,
      ].sort(),
    );
  });

  test("scopes each page to the matter it came from", async () => {
    const rows = await testDb
      .select({
        s3Keys: entityDeletionCleanupRequests.s3Keys,
        workspaceId: entityDeletionCleanupRequests.workspaceId,
      })
      .from(entityDeletionCleanupRequests)
      .where(
        eq(
          entityDeletionCleanupRequests.organizationId,
          fixture.organizationId,
        ),
      );

    // Filtering to the pages that break the rule beats asserting inside a loop:
    // the expectation names the offending page instead of reporting that some
    // unnamed row was false.
    expect(rows.filter((row) => !pageKeysMatchScope(row))).toEqual([]);
  });

  test("hands every still-publishable key to the buffer tombstone", async () => {
    const intents = await testDb
      .select({
        id: bufferObjectCleanupIntents.id,
        objectKey: bufferObjectCleanupIntents.objectKey,
        status: bufferObjectCleanupIntents.status,
        workspaceId: bufferObjectCleanupIntents.workspaceId,
      })
      .from(bufferObjectCleanupIntents)
      .where(
        eq(bufferObjectCleanupIntents.organizationId, fixture.organizationId),
      );

    expect(intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKey: fixture.pendingFinalKey }),
        {
          id: fixture.organizationWriterIntentId,
          objectKey: fixture.organizationWriterKey,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
          workspaceId: null,
        },
      ]),
    );
    expect(intents).toHaveLength(2);
  });

  test("leaves another organization's storage alone", async () => {
    expect(await recordedKeys(fixture.otherOrganizationId)).toEqual([]);

    const retainedTemplates = await testDb
      .select({ s3Key: templates.s3Key })
      .from(templates)
      .where(eq(templates.organizationId, fixture.otherOrganizationId));
    expect(retainedTemplates.map(({ s3Key }) => s3Key)).toEqual([
      fixture.otherTemplateKey,
    ]);

    // The same person's attachment in the organization that stays keeps both
    // its row and its object, even though its key is minted from the same user
    // id as the attachment that was just recorded for erasure.
    const retainedAttachments = await testDb
      .select({ s3Key: userFiles.s3Key })
      .from(userFiles)
      .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
      .where(eq(chatThreads.organizationId, fixture.otherOrganizationId));
    expect(retainedAttachments.map(({ s3Key }) => s3Key)).toEqual([
      fixture.otherChatAttachmentKey,
    ]);
    expect(await recordedKeys(fixture.otherOrganizationId)).not.toContain(
      fixture.otherChatAttachmentKey,
    );
  });

  test("completes the deletion the erasure instructions describe", async () => {
    expect(
      await testDb
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, fixture.organizationId)),
    ).toEqual([]);
    expect(
      await testDb
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.organizationId, fixture.organizationId)),
    ).toEqual([]);
  });

  test("refuses a deletion it cannot record in full", async () => {
    // The bound exists so enumeration cannot run without limit inside the
    // transaction that removes the organization. Reaching it has to reject the
    // deletion, never record a prefix: the pages left unwritten would name
    // objects nothing could ever find again. The organization that survives has
    // storage in more than one page, so one page is not enough for it.
    const attempt = await testDb
      .transaction(
        async (tx) =>
          await completeOrganizationDeletion({
            organizationId: fixture.otherOrganizationId,
            pagesMax: 1,
            tx: asTestRaw<Transaction>(tx),
          }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(attempt).toBeInstanceOf(OrganizationStorageTeardownBoundError);
    // Nothing was recorded and nothing was deleted: the rejection rolled the
    // whole attempt back.
    expect(await recordedKeys(fixture.otherOrganizationId)).toEqual([]);
    expect(
      await testDb
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, fixture.otherOrganizationId)),
    ).toHaveLength(1);
  });

  test("the erasure instructions outlive the cascade", async () => {
    expect((await recordedKeys(fixture.organizationId)).length).toBeGreaterThan(
      0,
    );
    const intents = await testDb
      .select({ id: bufferObjectCleanupIntents.id })
      .from(bufferObjectCleanupIntents)
      .where(
        eq(bufferObjectCleanupIntents.organizationId, fixture.organizationId),
      );
    expect(intents.length).toBe(2);
  });
});
