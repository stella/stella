import { TaggedError } from "better-result";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatThreads,
  desktopEditSessions,
  documentProcessingRuns,
  entityDeletionCleanupRequests,
  fields,
  folioCollabRooms,
  pendingUploads,
  styleSets,
  templateVersions,
  templates,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { preserveBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import { desktopEditMimeTypeForFileType } from "@/api/lib/desktop-edit-file-types";
import {
  createFileKey,
  createOcrSearchablePdfKey,
  createUserFileKey,
} from "@/api/lib/file-key";
import { extractFieldFileRefs } from "@/api/lib/files/field-file-refs";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import { LIMITS } from "@/api/lib/limits";
import {
  forEachOcrDerivativePage,
  ocrDerivativeCursorFilter,
  ocrDerivativePageOrder,
} from "@/api/lib/ocr-derivative-pages";
import {
  cancelRecoverableUploads,
  pendingUploadS3KeysForDeletion,
} from "@/api/lib/pending-upload-keys";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * Storage teardown for organization deletion.
 *
 * Deleting an organization cascades every row that names it, and those rows are
 * the only description of the objects the organization owns: object deletion
 * everywhere in this codebase is key-driven from database rows, nothing lists a
 * storage prefix, and the documents bucket expires only `tmp/` and `exports/`
 * keys. The erasure instructions therefore have to be written before the
 * cascade runs, into the two tombstone tables that deliberately reference
 * nothing (`entity_deletion_cleanup_requests`, `buffer_object_cleanup_intents`)
 * and so survive it. `apps/api/src/db/schema/entities.ts` states that contract
 * from the tombstones' side; this module is the organization half of it, and
 * `handlers/workspaces/delete.ts` is the matter half.
 *
 * Storage classes the enumeration covers, and how the deletion reaches each:
 *
 *   {org}/{matter}/{file}.{ext}   document sources, uploaded and restored
 *                                 versions, converted PDFs and image
 *                                 thumbnails — read from `fields.content`
 *                                 across every version of every document.
 *   {org}/{matter}/ocr/{run}.pdf  searchable-PDF derivatives, one per
 *                                 document-processing run.
 *   {org}/{matter}/{slot}.{ext}   desktop edit-session checkpoint slots, and
 *                                 the collaborative editor's snapshot and DOCX
 *                                 checkpoint slots.
 *   {org}/{matter}/tmp/{upload}   staged uploads that never finalized, plus the
 *                                 final key each one had already reserved.
 *   {org}/templates/…             template documents and their versions.
 *   {org}/style-sets/…            style-set packages, including one a
 *                                 replacement superseded.
 *   {user}/{file}.{ext}           chat attachments and their thumbnails. These
 *                                 belong to the organization, not to the user:
 *                                 the row hangs off a chat thread in this
 *                                 organization, and every row mints its key
 *                                 from its own id, so no other organization the
 *                                 same member belongs to can name the object.
 *
 * Deliberately not enumerated: `exports/…` report and chat exports, which the
 * bucket's lifecycle already expires, and the shared legal-corpus objects under
 * `case-law/` and `legal-corpus/`, which belong to no tenant.
 */

/** Keys recorded per cleanup request, and rows read per enumeration page. */
const TEARDOWN_PAGE_SIZE = LIMITS.ocrDerivativeCleanupBatchSize;

export class OrganizationStorageTeardownBoundError extends TaggedError(
  "OrganizationStorageTeardownBoundError",
)<{
  message: string;
  organizationId: SafeId<"organization">;
}> {}

/**
 * Sink for one page of keys. `workspaceId` names the matter the page came from,
 * or null for storage the organization owns directly, which never had one.
 */
type TeardownPageSink = (
  workspaceId: SafeId<"workspace"> | null,
  s3Keys: string[],
) => Promise<void>;

type OrganizationTeardownScope = {
  organizationId: SafeId<"organization">;
  tx: Transaction;
};

type OrganizationTeardownOptions = OrganizationTeardownScope & {
  /** Cleanup-request pages this deletion may record. Tests lower it. */
  pagesMax?: number;
};

/**
 * The previous page's last id, or null to start from the first row.
 *
 * The cursor carries the brand of the column it walks, so a walk cannot be
 * resumed from another table's id and the keyset comparison type-checks against
 * the column it compares. Every walk below reads its cursor straight off the
 * previous page's last row, which is already branded by the column's type, so
 * nothing has to be re-branded on the way round.
 */
type PageCursor<TId extends SafeIdType> = SafeId<TId> | null;

/**
 * Every walk below is recursion rather than a loop: a page is fully recorded
 * before its cursor advances, so "read a bounded page, durably record it, move
 * past it" stays an explicit sequence that no early exit can skip a page in. It
 * also keeps the awaited database calls out of a loop body, which this
 * repository's lint rules forbid.
 */

const recordFieldFilePage = async (
  scope: OrganizationTeardownScope,
  workspaceId: SafeId<"workspace">,
  record: TeardownPageSink,
  cursor: PageCursor<"field"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({ content: fields.content, id: fields.id })
    .from(fields)
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'file'`,
        cursor === null ? undefined : gt(fields.id, cursor),
      ),
    )
    .orderBy(asc(fields.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    workspaceId,
    page.flatMap((row) =>
      extractFieldFileRefs(row.content).map(({ fileId, mimeType }) =>
        createFileKey({
          fileId,
          mimeType,
          organizationId: scope.organizationId,
          workspaceId,
        }),
      ),
    ),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordFieldFilePage(scope, workspaceId, record, lastRow.id);
};

const recordOcrDerivatives = async (
  scope: OrganizationTeardownScope,
  workspaceId: SafeId<"workspace">,
  record: TeardownPageSink,
): Promise<void> =>
  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) =>
      await scope.tx
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.workspaceId, workspaceId),
            ocrDerivativeCursorFilter(cursor),
          ),
        )
        .orderBy(...ocrDerivativePageOrder())
        .limit(limit),
    onPage: async (runs) =>
      await record(
        workspaceId,
        runs.map(({ id }) =>
          createOcrSearchablePdfKey({
            organizationId: scope.organizationId,
            runId: id,
            workspaceId,
          }),
        ),
      ),
  });

const recordDesktopEditCheckpointPage = async (
  scope: OrganizationTeardownScope,
  workspaceId: SafeId<"workspace">,
  record: TeardownPageSink,
  cursor: PageCursor<"desktopEditSession"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({
      checkpointFileId: desktopEditSessions.checkpointFileId,
      fileType: desktopEditSessions.fileType,
      id: desktopEditSessions.id,
    })
    .from(desktopEditSessions)
    .where(
      and(
        eq(desktopEditSessions.workspaceId, workspaceId),
        cursor === null ? undefined : gt(desktopEditSessions.id, cursor),
      ),
    )
    .orderBy(asc(desktopEditSessions.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    workspaceId,
    page.map(({ checkpointFileId, fileType }) =>
      createFileKey({
        fileId: checkpointFileId,
        mimeType: desktopEditMimeTypeForFileType(fileType),
        organizationId: scope.organizationId,
        workspaceId,
      }),
    ),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordDesktopEditCheckpointPage(scope, workspaceId, record, lastRow.id);
};

const recordFolioCollabRoomFilePage = async (
  scope: OrganizationTeardownScope,
  workspaceId: SafeId<"workspace">,
  record: TeardownPageSink,
  cursor: PageCursor<"folioCollabRoom"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({
      docxCheckpointFileId: folioCollabRooms.docxCheckpointFileId,
      id: folioCollabRooms.id,
      yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
    })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.workspaceId, workspaceId),
        cursor === null ? undefined : gt(folioCollabRooms.id, cursor),
      ),
    )
    .orderBy(asc(folioCollabRooms.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    workspaceId,
    page.flatMap(({ docxCheckpointFileId, yjsSnapshotFileId }) => [
      createFileKey({
        fileId: yjsSnapshotFileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
        organizationId: scope.organizationId,
        workspaceId,
      }),
      createFileKey({
        fileId: docxCheckpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: scope.organizationId,
        workspaceId,
      }),
    ]),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordFolioCollabRoomFilePage(scope, workspaceId, record, lastRow.id);
};

/**
 * Staged uploads that never finalized. Both the staging object and the final
 * key the reservation had already claimed are recorded, and a reservation whose
 * writer may still publish additionally hands its key to the buffer tombstone,
 * the mechanism that already owns "an object may appear after the row
 * describing it is gone".
 */
const recordPendingUploadPage = async (
  scope: OrganizationTeardownScope,
  workspaceId: SafeId<"workspace">,
  record: TeardownPageSink,
  cursor: PageCursor<"pendingUpload"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({
      declaredMime: pendingUploads.declaredMime,
      id: pendingUploads.id,
      organizationId: pendingUploads.organizationId,
      purpose: pendingUploads.purpose,
      purposeData: pendingUploads.purposeData,
      status: pendingUploads.status,
      workspaceId: pendingUploads.workspaceId,
    })
    .from(pendingUploads)
    .where(
      and(
        eq(pendingUploads.workspaceId, workspaceId),
        ne(pendingUploads.status, "finalized"),
        cursor === null ? undefined : gt(pendingUploads.id, cursor),
      ),
    )
    .orderBy(asc(pendingUploads.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await preserveBufferObjectCleanupIntents(
    scope.tx,
    page.filter(({ status }) => status === "scanning" || status === "failed"),
  );
  await record(workspaceId, page.flatMap(pendingUploadS3KeysForDeletion));

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordPendingUploadPage(scope, workspaceId, record, lastRow.id);
};

type ChatAttachment = {
  s3Key: string;
  thumbnailFileId: string | null;
  userId: SafeId<"user">;
};

/**
 * Chat attachments and their thumbnails. The key is minted from the user id, so
 * it names no matter and the page is recorded against the organization itself.
 * `user_files.s3_key` is read rather than rebuilt, because it is the key the
 * upload actually wrote.
 */
const recordChatAttachmentPage = async (
  scope: OrganizationTeardownScope,
  record: TeardownPageSink,
  cursor: PageCursor<"userFile"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({
      id: userFiles.id,
      s3Key: userFiles.s3Key,
      thumbnailFileId: userFiles.thumbnailFileId,
      userId: userFiles.userId,
    })
    .from(userFiles)
    .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
    .where(
      and(
        eq(chatThreads.organizationId, scope.organizationId),
        cursor === null ? undefined : gt(userFiles.id, cursor),
      ),
    )
    .orderBy(asc(userFiles.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  // Branded here, at the read boundary: `user_files.user_id` is a plain text
  // column, and this is where the value read off the persisted row becomes the
  // ownership id the thumbnail key is built from. Nothing downstream sees the
  // bare string.
  const attachments: ChatAttachment[] = page.map((row) => ({
    s3Key: row.s3Key,
    thumbnailFileId: row.thumbnailFileId,
    userId: brandPersistedUserId(row.userId),
  }));

  await record(
    null,
    attachments.flatMap((attachment) =>
      attachment.thumbnailFileId === null
        ? [attachment.s3Key]
        : [
            attachment.s3Key,
            createUserFileKey({
              fileId: attachment.thumbnailFileId,
              mimeType: THUMBNAIL_MIME_TYPE,
              userId: attachment.userId,
            }),
          ],
    ),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordChatAttachmentPage(scope, record, lastRow.id);
};

const recordTemplatePage = async (
  scope: OrganizationTeardownScope,
  record: TeardownPageSink,
  cursor: PageCursor<"template"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({ id: templates.id, s3Key: templates.s3Key })
    .from(templates)
    .where(
      and(
        eq(templates.organizationId, scope.organizationId),
        cursor === null ? undefined : gt(templates.id, cursor),
      ),
    )
    .orderBy(asc(templates.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    null,
    page.map(({ s3Key }) => s3Key),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordTemplatePage(scope, record, lastRow.id);
};

const recordTemplateVersionPage = async (
  scope: OrganizationTeardownScope,
  record: TeardownPageSink,
  cursor: PageCursor<"templateVersion"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({ id: templateVersions.id, s3Key: templateVersions.s3Key })
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.organizationId, scope.organizationId),
        cursor === null ? undefined : gt(templateVersions.id, cursor),
      ),
    )
    .orderBy(asc(templateVersions.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    null,
    page.map(({ s3Key }) => s3Key),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordTemplateVersionPage(scope, record, lastRow.id);
};

const recordStyleSetPage = async (
  scope: OrganizationTeardownScope,
  record: TeardownPageSink,
  cursor: PageCursor<"styleSet"> = null,
): Promise<void> => {
  const page = await scope.tx
    .select({
      cleanupS3Key: styleSets.cleanupS3Key,
      id: styleSets.id,
      s3Key: styleSets.s3Key,
    })
    .from(styleSets)
    .where(
      and(
        eq(styleSets.organizationId, scope.organizationId),
        cursor === null ? undefined : gt(styleSets.id, cursor),
      ),
    )
    .orderBy(asc(styleSets.id))
    .limit(TEARDOWN_PAGE_SIZE);
  if (page.length === 0) {
    return;
  }

  await record(
    null,
    page.flatMap(({ cleanupS3Key, s3Key }) =>
      cleanupS3Key === null ? [s3Key] : [s3Key, cleanupS3Key],
    ),
  );

  const lastRow = page.length < TEARDOWN_PAGE_SIZE ? undefined : page.at(-1);
  if (!lastRow) {
    return;
  }
  await recordStyleSetPage(scope, record, lastRow.id);
};

/**
 * One matter at a time, recursively for the same reason the page walks are:
 * each matter is fully recorded before the next starts, and the awaited reads
 * stay out of a loop body.
 */
const recordMatterStorage = async (
  scope: OrganizationTeardownScope,
  workspaceIds: SafeId<"workspace">[],
  record: TeardownPageSink,
  index = 0,
): Promise<void> => {
  const workspaceId = workspaceIds.at(index);
  if (workspaceId === undefined) {
    return;
  }
  await recordFieldFilePage(scope, workspaceId, record);
  await recordOcrDerivatives(scope, workspaceId, record);
  await recordDesktopEditCheckpointPage(scope, workspaceId, record);
  await recordFolioCollabRoomFilePage(scope, workspaceId, record);
  await recordPendingUploadPage(scope, workspaceId, record);
  await recordMatterStorage(scope, workspaceIds, record, index + 1);
};

type OrganizationStorageTeardownResult = {
  requestIds: SafeId<"entityDeletionCleanupRequest">[];
};

/**
 * Write the organization's storage-erasure instructions into the tombstone
 * tables.
 *
 * Enumeration is bounded twice: each page is one bounded read that becomes one
 * durable request row, and the number of pages a single deletion may record is
 * capped, so a deletion cannot enumerate without limit inside the transaction
 * that removes the organization. Reaching either bound rejects the deletion
 * rather than dropping the remainder, because a page that is never recorded is
 * an object nothing can name again.
 */
export const recordOrganizationStorageTeardown = async ({
  organizationId,
  pagesMax = LIMITS.organizationStorageTeardownPagesMax,
  tx,
}: OrganizationTeardownOptions): Promise<OrganizationStorageTeardownResult> => {
  const requestIds: SafeId<"entityDeletionCleanupRequest">[] = [];
  // The scope is annotated rather than left to `TeardownPageSink`'s contextual
  // type: an ownership id reaching a sink has to declare its brand where the
  // parameter is written, so no future edit can widen it to a bare string
  // without the change being visible right here.
  const record: TeardownPageSink = async (
    workspaceId: SafeId<"workspace"> | null,
    s3Keys: string[],
  ) => {
    const uniqueKeys = [...new Set(s3Keys)];
    if (uniqueKeys.length === 0) {
      return;
    }
    if (requestIds.length >= pagesMax) {
      throw new OrganizationStorageTeardownBoundError({
        message:
          "This organization holds more stored files than one deletion can " +
          "clear. Delete some matters first, then delete the organization.",
        organizationId,
      });
    }
    const requestId = createSafeId<"entityDeletionCleanupRequest">();
    // audit: skip — storage-erasure bookkeeping for the organization deletion
    // the endpoint already answers for; the request rows carry no user-visible
    // state of their own.
    await tx.insert(entityDeletionCleanupRequests).values({
      id: requestId,
      organizationId,
      s3Keys: uniqueKeys,
      workspaceId,
    });
    requestIds.push(requestId);
  };

  const scope = { organizationId, tx };
  const workspaceRows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(asc(workspaces.id))
    .limit(LIMITS.workspacesCount + 1);
  if (workspaceRows.length > LIMITS.workspacesCount) {
    throw new OrganizationStorageTeardownBoundError({
      message:
        "This organization holds more matters than one deletion can clear. " +
        "Delete some matters first, then delete the organization.",
      organizationId,
    });
  }

  // Seal before enumerating, exactly as the matter deletion does: mark every
  // matter `deleting` so no further lease is granted, then cancel the leases
  // already out. Without this an upload could publish after its keys were
  // read and survive the cascade with no row naming it.
  const workspaceIds = workspaceRows.map(({ id }) => id);
  if (workspaceIds.length > 0) {
    // audit: skip — internal seal wrapping the organization deletion the
    // endpoint already answers for.
    await tx
      .update(workspaces)
      .set({ status: "deleting" })
      .where(inArray(workspaces.id, workspaceIds));
  }
  await cancelRecoverableUploads(tx, workspaceIds);

  await recordChatAttachmentPage(scope, record);
  await recordTemplatePage(scope, record);
  await recordTemplateVersionPage(scope, record);
  await recordStyleSetPage(scope, record);
  await recordMatterStorage(scope, workspaceIds, record);

  return { requestIds };
};

/**
 * Complete one organization's deletion: record every storage-erasure
 * instruction, remove the chat rows that own storage, and delete the
 * organization, all inside the caller's single transaction.
 *
 * The organization row is deleted here rather than left to the caller so that
 * the instructions and the cascade that strands the objects commit together.
 * Recording the instructions in an earlier transaction would be the dangerous
 * ordering: were the cascade then to fail, the erasure worker would already
 * hold keys naming a live organization's documents. Committing both together
 * means the tombstones exist only in the world where the objects they name have
 * genuinely lost their rows.
 *
 * Chat attachments go for the same reason the matter deletion removes them:
 * `user_files.thread_id` is `ON DELETE RESTRICT`, so those rows do not leave on
 * their own, and the objects they name are the ones this teardown just
 * recorded. Their threads follow, which is also what lets the organization's
 * own cascade reach its matters, since `chat_threads.workspace_id` is
 * `ON DELETE RESTRICT` too.
 */
export const completeOrganizationDeletion = async ({
  organizationId,
  pagesMax,
  tx,
}: OrganizationTeardownOptions): Promise<OrganizationStorageTeardownResult> => {
  const teardown = await recordOrganizationStorageTeardown({
    organizationId,
    ...(pagesMax === undefined ? {} : { pagesMax }),
    tx,
  });

  const organizationThreadIds = tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.organizationId, organizationId));

  // audit: skip — the storage-owning rows of the organization deletion the
  // endpoint already answers for.
  await tx
    .delete(userFiles)
    .where(inArray(userFiles.threadId, organizationThreadIds));
  await tx
    .delete(chatThreads)
    .where(eq(chatThreads.organizationId, organizationId));
  await tx.delete(organization).where(eq(organization.id, organizationId));

  return teardown;
};
