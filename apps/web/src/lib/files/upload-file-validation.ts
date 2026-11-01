import { Result, TaggedError } from "better-result";

import {
  UPLOAD_DOCUMENT_MAX_BYTES,
  UPLOAD_FILE_MIN_BYTES,
} from "@stll/api-contract/limits";

import { getTranslator } from "@/i18n/translator";

const BYTES_PER_MEGABYTE = 1024 * 1024;

export class UploadFileSizeError extends TaggedError("UploadFileSizeError")<{
  message: string;
}> {}

/** What a file over `limitBytes` is told, by the browser or for the API. */
export const uploadFileTooLargeMessage = (limitBytes: number): string =>
  getTranslator()("workspaces.files.fileTooLarge", {
    limit: limitBytes / BYTES_PER_MEGABYTE,
  });

/** Whether the API would accept this size, checked before any byte is read. */
export const validateUploadFileSize = (
  size: number,
): Result<void, UploadFileSizeError> => {
  if (size < UPLOAD_FILE_MIN_BYTES) {
    return Result.err(
      new UploadFileSizeError({
        message: getTranslator()("workspaces.files.emptyFile"),
      }),
    );
  }
  if (size > UPLOAD_DOCUMENT_MAX_BYTES) {
    return Result.err(
      new UploadFileSizeError({
        message: uploadFileTooLargeMessage(UPLOAD_DOCUMENT_MAX_BYTES),
      }),
    );
  }
  return Result.ok();
};
