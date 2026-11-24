import { Result } from "better-result";

import {
  EMAIL_CITATION_BLOCK_MODE,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import type { EmailReading } from "@stll/api-contract/email-reading";
import type { FilePart } from "@stll/api-contract/file-parts";

import type { ScopedDb } from "@/api/db/safe-db-types";
import { HTTP_FAILURE } from "@/api/http/errors";
import { AUDIT_RESOURCE_TYPE, type AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import {
  buildEmailPreview,
  describeEmailAttachments,
  emailBodyToText,
  type ParsedEmail,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import {
  fileFieldQuery,
  LIVE_VERSION_DELIVERY,
  recordLiveVersionDelivery,
} from "@/api/lib/files/live-version-field";
import {
  attachmentsWithin,
  readEmailPart,
} from "@/api/lib/files/read-email-part";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";

type ReadEmailFileOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  fieldId: SafeId<"field">;
  recordAuditEvent: AuditRecorder;
  /** An email that is a part of the file, such as a mailbox's message. */
  part?: FilePart | undefined;
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
 * An email file's header, body text and attachments (and a certified
 * email's certification data), read from the stored file by the same email
 * reader the web viewer, search and AI use. A file that is not an email, or
 * cannot be read as one, is refused as preview-unavailable, so a reader can
 * fall back to its own view.
 */
/** An email as a reader that does not render email reads it. */
const emailReading = async (email: ParsedEmail): Promise<EmailReading> => {
  // The same attachments the web viewer lists, inline images left out.
  const attachments = await describeEmailAttachments(
    email,
    buildEmailPreview(email, {
      citationBlockMode: EMAIL_CITATION_BLOCK_MODE.omit,
    }).attachments,
  );
  return {
    certified: email.certified,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    text: emailBodyToText(email.body),
    attachments: attachments.map(
      ({ part, fileName, mediaType, sizeBytes }) => ({
        part,
        fileName,
        mediaType,
        sizeBytes,
      }),
    ),
  };
};

/**
 * An email that is a part of a stored file, read through the part link's
 * reader, which records its delivery with the part.
 */
const readEmailPartReading = async ({
  part,
  ...options
}: ReadEmailFileOptions & { part: FilePart }): Promise<
  Result<EmailReading, HandlerError>
> => {
  const read = await readEmailPart({ ...options, part });
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const parsed = await parseEmail(read.value.buffer, read.value.mimeType);
  if (parsed.isErr()) {
    return unavailable("The email could not be read");
  }
  const reading = await emailReading(parsed.value);
  return Result.ok({
    ...reading,
    attachments: attachmentsWithin(reading.attachments, part),
  });
};

export const readEmailFile = async ({
  scopedDb,
  workspaceId,
  organizationId,
  fieldId,
  recordAuditEvent,
  part,
}: ReadEmailFileOptions): Promise<Result<EmailReading, HandlerError>> => {
  if (part !== undefined) {
    return await readEmailPartReading({
      scopedDb,
      workspaceId,
      organizationId,
      fieldId,
      recordAuditEvent,
      part,
    });
  }
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
    return unavailable("This file is not an email");
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
  if (parsed.isErr()) {
    return unavailable("The email could not be read");
  }
  const email = parsed.value;
  const reading = await emailReading(email);
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
          format: email.certified === null ? "email" : "certified-email",
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        },
      }),
  });
  if (delivery === LIVE_VERSION_DELIVERY.withdrawn) {
    return missingFile();
  }
  return Result.ok(reading);
};
