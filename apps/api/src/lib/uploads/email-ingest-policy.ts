import { Result } from "better-result";

import { EML_MIME_TYPE, MSG_MIME_TYPE } from "@/api/lib/files/email-to-html";
import { parseOutlookMsg } from "@/api/lib/files/outlook-msg";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { finalizeErr, UploadFinalizeError } from "@/api/lib/uploads/runtime";

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

/**
 * Final-object cleanup is retryable storage work. Keep it transient so the
 * upload FSM leaves the pending row in `failed` and the recovery sweep can
 * retry the persisted object keys.
 */
export const emailIngestFinalObjectCleanupFailure = (): UploadFinalizeError =>
  new UploadFinalizeError({
    status: 500,
    message: "Failed to clean up email ingest objects",
    rejectReason: "final-object-cleanup-failed",
  });

export const validateEmailAttachmentMimeType = (
  buffer: Uint8Array,
  mimeType: string,
): Result<void, UploadFinalizeError> => {
  if (
    mimeType !== EML_MIME_TYPE &&
    mimeType !== MSG_MIME_TYPE &&
    detectEmailContainer(buffer) === null
  ) {
    return Result.ok();
  }
  return finalizeErr({
    status: 422,
    message: "Nested email attachments are not supported",
    rejectReason: "nested-email-attachment",
  });
};

const CFB_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const EMAIL_HEADER_LIMIT_BYTES = 64 * 1024;
const EMAIL_HEADER_PATTERN =
  /^(?:bcc|cc|content-type|date|from|message-id|mime-version|reply-to|subject|to):/imu;

const startsWith = (buffer: Uint8Array, signature: Uint8Array): boolean => {
  if (buffer.byteLength < signature.byteLength) {
    return false;
  }
  return signature.every((byte, index) => buffer[index] === byte);
};

const tightArrayBuffer = (buffer: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
};

export const detectEmailContainer = (
  buffer: Uint8Array,
): "eml" | "msg" | null => {
  if (startsWith(buffer, CFB_SIGNATURE)) {
    const parsed = Result.try(() => parseOutlookMsg(tightArrayBuffer(buffer)));
    return Result.isOk(parsed) ? "msg" : null;
  }

  const headerSample = new TextDecoder().decode(
    buffer.subarray(0, EMAIL_HEADER_LIMIT_BYTES),
  );
  const headerEnd = headerSample.search(/\r?\n\r?\n/u);
  // Keep this detector bounded. A valid header can contain a very large
  // folded field, so its separator may fall outside the sample. Seeing a
  // standard RFC 5322 header before that boundary is enough to classify the
  // bytes as an email; rejecting a false positive attachment is safer than
  // allowing a nested message to bypass the MIME guard.
  const headerText =
    headerEnd === -1 ? headerSample : headerSample.slice(0, headerEnd);
  return EMAIL_HEADER_PATTERN.test(headerText) ? "eml" : null;
};

export const validateEmailIngestContainer = (
  buffer: Uint8Array,
  declaredMime: string,
): Result<void, UploadFinalizeError> => {
  const expected = declaredMime === MSG_MIME_TYPE ? "msg" : "eml";
  if (detectEmailContainer(buffer) === expected) {
    return Result.ok();
  }
  return finalizeErr({
    status: 422,
    message: "Uploaded email does not match its declared container format",
    rejectReason: "email-container-mismatch",
  });
};

export const resolveStoredEmailFileName = (name: string, mimeType: string) => {
  const extension = mimeType === MSG_MIME_TYPE ? ".msg" : ".eml";
  const withExtension = name.toLowerCase().endsWith(extension)
    ? name
    : `${name}${extension}`;
  return sanitizeFilenamePreservingExtension(withExtension);
};
