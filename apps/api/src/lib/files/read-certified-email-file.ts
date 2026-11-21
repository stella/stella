import { Result } from "better-result";

import {
  EMAIL_CITATION_BLOCK_MODE,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import type { CertifiedEmailRead } from "@stll/api-contract/certified-email";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";

import type { ScopedDb } from "@/api/db/safe-db";
import { HTTP_FAILURE } from "@/api/http/errors";
import { AUDIT_RESOURCE_TYPE, type AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import {
  buildEmailPreview,
  emailMessageText,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import {
  fileFieldQuery,
  LIVE_VERSION_DELIVERY,
  recordLiveVersionDelivery,
} from "@/api/lib/files/live-version-field";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

type ReadCertifiedEmailFileOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  fieldId: SafeId<"field">;
  recordAuditEvent: AuditRecorder;
};

const missingFile = () =>
  Result.err(
    new HandlerError({
      status: 404,
      code: HTTP_FAILURE.notFound,
      message: "File not found",
    }),
  );

const unavailable = (message: string) =>
  Result.err(
    new HandlerError({
      status: 422,
      code: PREVIEW_UNAVAILABLE_ERROR_CODE,
      message,
    }),
  );

/**
 * A certified email's envelope and text, read from the stored file by the
 * same email reader the web viewer, search and AI use. Any other file is
 * refused as preview-unavailable, so a reader can fall back to its own view.
 */
export const readCertifiedEmailFile = async ({
  scopedDb,
  workspaceId,
  organizationId,
  fieldId,
  recordAuditEvent,
}: ReadCertifiedEmailFileOptions): Promise<
  Result<CertifiedEmailRead, HandlerError>
> => {
  const [row] = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  if (row?.content.type !== "file") {
    return missingFile();
  }
  const { content, entityId } = row;
  const emailMimeType = resolveEmailMimeType({
    fileName: content.fileName,
    mimeType: content.mimeType,
  });
  if (content.encrypted || emailMimeType === null) {
    return unavailable("This file is not a certified email");
  }
  if (content.sizeBytes > FILE_SIZE_LIMIT_BYTES.document) {
    return unavailable("The email exceeds the preview size limit");
  }
  const { bytes } = await readStoredFile({
    key: createFileKey({
      organizationId,
      workspaceId,
      fileId: content.id,
      mimeType: content.mimeType,
    }),
    mimeType: content.mimeType,
  });
  const parsed = await parseEmail(bytes, emailMimeType);
  const email = parsed.isOk() ? parsed.value : null;
  const envelope = email?.certified ?? null;
  if (email === null || envelope === null) {
    return unavailable("This file is not a certified email");
  }
  // The same attachments the web viewer lists, inline images left out.
  const { attachments } = buildEmailPreview(email, {
    citationBlockMode: EMAIL_CITATION_BLOCK_MODE.omit,
  });
  const delivery = await recordLiveVersionDelivery({
    scopedDb,
    fieldId,
    workspaceId,
    record: async (tx) =>
      await recordAuditEvent(tx, {
        action: CONTENT_DELIVERY_AUDIT_ACTION.inline,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: entityId,
        workspaceId,
        metadata: {
          disposition: "inline",
          fieldId,
          format: "certified-email",
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        },
      }),
  });
  if (delivery === LIVE_VERSION_DELIVERY.withdrawn) {
    return missingFile();
  }
  return Result.ok({
    envelope,
    text: emailMessageText(email),
    attachments: attachments.map(({ fileName, sizeBytes }) => ({
      fileName,
      sizeBytes,
    })),
  });
};
