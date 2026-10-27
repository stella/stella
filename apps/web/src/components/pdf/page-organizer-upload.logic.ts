import type { SafeId } from "@/lib/safe-id";

export type PageOrganizerUploadReceipt = {
  entityVersionId: SafeId<"entityVersion">;
  fileId: string;
};

export type PageOrganizerUploadOutcome =
  | { type: "pending"; uploadId: number }
  | ({ type: "completed"; uploadId: number } & PageOrganizerUploadReceipt)
  | { type: "cancelled"; uploadId: number }
  | { type: "superseded"; uploadId: number }
  | { type: "failed"; uploadId: number; error: unknown };

export type CompletedPageOrganizerUpload = Extract<
  PageOrganizerUploadOutcome,
  { type: "completed" }
>;

type PendingPageOrganizerUpload = Extract<
  PageOrganizerUploadOutcome,
  { type: "pending" }
>;

export type PageOrganizerUploadOwner = ReturnType<
  typeof createPageOrganizerUploadOwner
>;

/** Owns upload identity so an obsolete async result cannot become committable. */
export function createPageOrganizerUploadOwner() {
  let nextUploadId = 0;
  let current: PageOrganizerUploadOutcome | null = null;

  return {
    begin(): PendingPageOrganizerUpload {
      if (current?.type === "pending") {
        current = { type: "superseded", uploadId: current.uploadId };
      }
      const pending = { type: "pending", uploadId: ++nextUploadId } as const;
      current = pending;
      return pending;
    },
    cancel(pending: PendingPageOrganizerUpload): void {
      if (current === pending) {
        current = { type: "cancelled", uploadId: pending.uploadId };
      }
    },
    cancelCurrent(): void {
      if (current?.type === "pending") {
        current = { type: "cancelled", uploadId: current.uploadId };
      }
    },
    complete(
      pending: PendingPageOrganizerUpload,
      receipt: PageOrganizerUploadReceipt,
    ): PageOrganizerUploadOutcome {
      if (current !== pending) {
        return current?.uploadId === pending.uploadId
          ? current
          : { type: "superseded", uploadId: pending.uploadId };
      }
      const completed = {
        type: "completed",
        uploadId: pending.uploadId,
        entityVersionId: receipt.entityVersionId,
        fileId: receipt.fileId,
      } as const;
      current = completed;
      return completed;
    },
    fail(
      pending: PendingPageOrganizerUpload,
      error: unknown,
    ): PageOrganizerUploadOutcome {
      if (current !== pending) {
        return current?.uploadId === pending.uploadId
          ? current
          : { type: "superseded", uploadId: pending.uploadId };
      }
      const failed = {
        type: "failed",
        uploadId: pending.uploadId,
        error,
      } as const;
      current = failed;
      return failed;
    },
  };
}

export function commitCompletedUpload<T>(
  upload: CompletedPageOrganizerUpload,
  commit: (upload: CompletedPageOrganizerUpload) => T,
): T {
  return commit(upload);
}
