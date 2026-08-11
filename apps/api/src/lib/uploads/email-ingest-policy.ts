import { Result } from "better-result";

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
