import { Result, TaggedError } from "better-result";

import {
  uploadErrorStatus,
  uploadFailureDisposition,
} from "@/lib/upload-queue";

class FileEntityUploadError extends TaggedError("FileEntityUploadError")<{
  message: string;
  cause: unknown;
  status: number;
  response: Response | undefined;
}> {}

const normalizeUploadError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new FileEntityUploadError({
    message: "Upload request failed",
    cause: error,
    status: uploadErrorStatus(error),
    response:
      error !== null &&
      typeof error === "object" &&
      "response" in error &&
      error.response instanceof Response
        ? error.response
        : undefined,
  });
};

export type FileEntityUploadGrant = {
  uploadId: string;
  url: string;
  headers: Record<string, string>;
};

export type FileEntityUploadSteps<TResult> = {
  /** An upload reservation for the file: a prepared one or a fresh presign. */
  reserve: (file: File, signal: AbortSignal) => Promise<FileEntityUploadGrant>;
  /**
   * PUT the bytes to the reserved URL. Throws when storage does not accept
   * them, after releasing the reservation itself.
   */
  put: (
    file: File,
    grant: FileEntityUploadGrant,
    signal: AbortSignal,
  ) => Promise<void>;
  finalize: (uploadId: string, signal: AbortSignal) => Promise<TResult>;
  /** Best effort: release an upload that will not be finalized. */
  abort: (uploadId: string) => Promise<void>;
};

/**
 * Every failure the queue can retry retains the same finalization identity:
 * the server may already have committed or retained its staged bytes. Using
 * the queue's disposition keeps automatic and manual retries from creating
 * another upload when a response is lost or a request times out.
 */
export const finalizeFailureKeepsUpload = (error: unknown): boolean =>
  uploadFailureDisposition(error) === "retryable";

export type FileEntityUploader<TResult> = {
  /** One attempt for the file; the upload queue calls it again on retry. */
  upload: (file: File, signal: AbortSignal) => Promise<Result<TResult, Error>>;
  /** Release every upload whose bytes are staged but not finalized. */
  abortStaged: () => Promise<void>;
};

/**
 * Drives reserve, PUT and finalize for each file and remembers, per file, an
 * upload whose bytes are already staged. A retry of that file finalizes the
 * same upload id again; it reserves and PUTs anew only after the PUT itself
 * failed or the server refused the finalize for good.
 */
export const createFileEntityUploader = <TResult>(
  steps: FileEntityUploadSteps<TResult>,
): FileEntityUploader<TResult> => {
  const stagedUploadIds = new Map<File, string>();

  const upload = async (
    file: File,
    signal: AbortSignal,
  ): Promise<Result<TResult, Error>> => {
    const attempted = await Result.tryPromise({
      try: async () => {
        let uploadId = stagedUploadIds.get(file);
        if (uploadId === undefined) {
          const grant = await steps.reserve(file, signal);
          await steps.put(file, grant, signal);
          uploadId = grant.uploadId;
          stagedUploadIds.set(file, uploadId);
        }

        const finalized = await Result.tryPromise({
          try: async () => await steps.finalize(uploadId, signal),
          catch: (error) => error,
        });
        if (Result.isOk(finalized)) {
          stagedUploadIds.delete(file);
          return finalized;
        }

        const error = finalized.error;
        const stillStaged = stagedUploadIds.get(file) === uploadId;
        if (signal.aborted || !finalizeFailureKeepsUpload(error)) {
          stagedUploadIds.delete(file);
        }
        if (signal.aborted && stillStaged) {
          // Cancelled while this finalize was in flight, and the batch's
          // `abortStaged` has not released this upload yet.
          await steps.abort(uploadId);
        }
        return finalized;
      },
      catch: (error) => error,
    });
    return attempted.andThen((result) => result).mapError(normalizeUploadError);
  };

  const abortStaged = async (): Promise<void> => {
    const uploadIds = [...stagedUploadIds.values()];
    stagedUploadIds.clear();
    for (const uploadId of uploadIds) {
      await steps.abort(uploadId);
    }
  };

  return { upload, abortStaged };
};
