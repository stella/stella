import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createEmailAttachmentDescriptor,
  findEmailAttachmentIndex,
} from "@/api/lib/files/email-attachment-token";
import { EMAIL_CITATION_BLOCK_MODE } from "@/api/lib/files/email-citations";
import {
  buildEmailPreview,
  parseEmail,
  resolveEmailMimeType,
} from "@/api/lib/files/email-to-html";
import { createFileKey, resolveUploadMime } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { readS3ArrayBuffer } from "@/api/lib/s3";

export const EMAIL_ATTACHMENT_LOAD_STATUS = {
  loaded: "loaded",
  notFound: "not-found",
  tooLarge: "too-large",
  unreadable: "unreadable",
} as const;

type EmailAttachmentLoadResult =
  | {
      status: typeof EMAIL_ATTACHMENT_LOAD_STATUS.loaded;
      bytes: Uint8Array;
      fileName: string;
      mimeType: string;
      sourceEntityId: SafeId<"entity">;
    }
  | { status: typeof EMAIL_ATTACHMENT_LOAD_STATUS.notFound }
  | { status: typeof EMAIL_ATTACHMENT_LOAD_STATUS.tooLarge }
  | { status: typeof EMAIL_ATTACHMENT_LOAD_STATUS.unreadable };

const emailAttachmentFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        entityVersionId: entityVersions.id,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      // Withdrawn versions remain under legal hold, but their bytes must not
      // remain reachable through a previously captured field identifier.
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

const normalizedAttachmentMimeType = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string | null;
}) =>
  resolveUploadMime({
    declaredMime:
      mimeType?.split(";").at(0)?.trim().toLowerCase() ||
      "application/octet-stream",
    fileName,
  });

export const loadEmailAttachment = async function* ({
  attachmentId,
  fieldId,
  organizationId,
  scopedDb,
  secret,
  workspaceId,
}: {
  attachmentId: string;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  secret: string;
  workspaceId: SafeId<"workspace">;
}) {
  const rows = yield* Result.await(
    Result.tryPromise(
      async () =>
        await emailAttachmentFieldQuery(scopedDb, fieldId, workspaceId),
    ),
  );
  const row = rows.at(0);
  if (!row || row.content.type !== "file" || row.content.encrypted) {
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.notFound,
    } as const satisfies EmailAttachmentLoadResult;
  }

  const content = row.content;
  const emailMimeType = resolveEmailMimeType({
    fileName: content.fileName,
    mimeType: content.mimeType,
  });
  if (!emailMimeType) {
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.notFound,
    } as const satisfies EmailAttachmentLoadResult;
  }

  const attachmentIndex = findEmailAttachmentIndex({
    descriptor: attachmentId,
    secret,
    sourceFileId: content.id,
    sourceVersionId: row.entityVersionId,
  });
  if (attachmentIndex === null) {
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.notFound,
    } as const satisfies EmailAttachmentLoadResult;
  }
  if (content.sizeBytes > FILE_SIZE_LIMIT_BYTES.document) {
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.tooLarge,
    } as const satisfies EmailAttachmentLoadResult;
  }

  const sourceBuffer = yield* Result.await(
    Result.tryPromise(
      async () =>
        await readS3ArrayBuffer(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: content.id,
            mimeType: content.mimeType,
          }),
        ),
    ),
  );
  const parsedResult = await Result.tryPromise(
    async () => await parseEmail(sourceBuffer, emailMimeType),
  );
  if (Result.isError(parsedResult)) {
    captureError(parsedResult.error, {
      fieldId,
      mimeType: emailMimeType,
      workspaceId,
    });
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.unreadable,
    } as const satisfies EmailAttachmentLoadResult;
  }

  const preview = buildEmailPreview(parsedResult.value, {
    citationBlockMode: EMAIL_CITATION_BLOCK_MODE.omit,
    createAttachmentId: (index) =>
      createEmailAttachmentDescriptor({
        attachmentIndex: index,
        secret,
        sourceFileId: content.id,
        sourceVersionId: row.entityVersionId,
      }),
  });
  const descriptor = preview.attachments.find(({ id }) => id === attachmentId);
  const attachment = parsedResult.value.attachments.at(attachmentIndex);
  if (!descriptor || !attachment) {
    return {
      status: EMAIL_ATTACHMENT_LOAD_STATUS.notFound,
    } as const satisfies EmailAttachmentLoadResult;
  }

  const fileName = attachment.fileName ?? "attachment";
  return {
    status: EMAIL_ATTACHMENT_LOAD_STATUS.loaded,
    bytes: attachment.bytes,
    fileName,
    mimeType: normalizedAttachmentMimeType({
      fileName,
      mimeType: attachment.mimeType,
    }),
    sourceEntityId: row.entityId,
  } as const satisfies EmailAttachmentLoadResult;
};
