import { Result } from "better-result";

import { EML_MIME_TYPE, MSG_MIME_TYPE } from "@/api/lib/files/email-to-html";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  finalizeErr,
  type UploadFinalizeError,
} from "@/api/lib/uploads/runtime";

/** Upper bound on attachments materialized per email. */
const MAX_EMAIL_ATTACHMENTS = 50;

export const validateEmailAttachmentCount = (
  attachmentCount: number,
): Result<void, UploadFinalizeError> => {
  if (attachmentCount <= MAX_EMAIL_ATTACHMENTS) {
    return Result.ok();
  }
  return finalizeErr({
    status: 422,
    message: `Email has more than ${MAX_EMAIL_ATTACHMENTS} attachments`,
    rejectReason: "too-many-attachments",
  });
};

export const validateEmailAttachmentMimeType = (
  mimeType: string,
): Result<void, UploadFinalizeError> => {
  if (mimeType !== EML_MIME_TYPE && mimeType !== MSG_MIME_TYPE) {
    return Result.ok();
  }
  return finalizeErr({
    status: 422,
    message: "Nested email attachments are not supported",
    rejectReason: "nested-email-attachment",
  });
};

export const resolveStoredEmailFileName = (name: string, mimeType: string) => {
  const extension = mimeType === MSG_MIME_TYPE ? ".msg" : ".eml";
  const withExtension = name.toLowerCase().endsWith(extension)
    ? name
    : `${name}${extension}`;
  return sanitizeFilenamePreservingExtension(withExtension);
};
