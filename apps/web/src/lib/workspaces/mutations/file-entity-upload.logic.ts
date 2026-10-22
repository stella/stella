import { isTransientUploadStatus, uploadErrorStatus } from "@/lib/upload-queue";

const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;

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
 * Whether a finalize that failed can still complete on the same upload: no
 * answer or a server error (the server may have committed it, or kept the
 * staged bytes for a retry), a claim that is still busy or cooling down
 * (409), or a rate limit (429). The upload id then stays the one to finalize,
 * so a retry replays a committed result instead of uploading a second copy.
 * Any other answer is the server's final word on that upload.
 */
export const finalizeFailureKeepsUpload = (error: unknown): boolean => {
  const status = uploadErrorStatus(error);
  return (
    isTransientUploadStatus(status) ||
    status === HTTP_CONFLICT ||
    status === HTTP_TOO_MANY_REQUESTS
  );
};

export type FileEntityUploader<TResult> = {
  /** One attempt for the file; the upload queue calls it again on retry. */
  upload: (file: File, signal: AbortSignal) => Promise<TResult>;
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

  const upload = async (file: File, signal: AbortSignal): Promise<TResult> => {
    let uploadId = stagedUploadIds.get(file);
    if (uploadId === undefined) {
      const grant = await steps.reserve(file, signal);
      await steps.put(file, grant, signal);
      uploadId = grant.uploadId;
      stagedUploadIds.set(file, uploadId);
    }

    try {
      const result = await steps.finalize(uploadId, signal);
      stagedUploadIds.delete(file);
      return result;
    } catch (error) {
      const stillStaged = stagedUploadIds.get(file) === uploadId;
      if (signal.aborted || !finalizeFailureKeepsUpload(error)) {
        stagedUploadIds.delete(file);
      }
      if (signal.aborted && stillStaged) {
        // Cancelled while this finalize was in flight, and the batch's
        // `abortStaged` has not released this upload yet.
        await steps.abort(uploadId);
      }
      throw error;
    }
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
