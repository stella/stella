import type { SafeId } from "@/lib/safe-id";

const organizerOperationBrand: unique symbol = Symbol("organizer-operation");
const organizerRequestBrand: unique symbol = Symbol("organizer-request");

/** An organizer-owned capability. Its runtime validity must be checked at use. */
export type LiveOrganizerOperation = {
  readonly [organizerOperationBrand]: true;
};

export type OrganizerOperationRequest = {
  readonly [organizerRequestBrand]: true;
  readonly operation: LiveOrganizerOperation;
  readonly requestId: number;
};

export type PageOrganizerOperationOwner = ReturnType<
  typeof createPageOrganizerOperationOwner
>;

/** Owns the capability for one mounted organizer and sequences its transforms. */
export function createPageOrganizerOperationOwner() {
  const operation: LiveOrganizerOperation = {
    [organizerOperationBrand]: true,
  };
  let live = true;
  let latestRequestId = 0;

  return {
    operation,
    beginRequest(candidate: LiveOrganizerOperation): OrganizerOperationRequest {
      return {
        [organizerRequestBrand]: true,
        operation: candidate,
        requestId: ++latestRequestId,
      };
    },
    isLive(candidate: LiveOrganizerOperation): boolean {
      return live && candidate === operation;
    },
    isCurrent(request: OrganizerOperationRequest): boolean {
      return (
        live &&
        request.operation === operation &&
        request.requestId === latestRequestId
      );
    },
    revoke(): void {
      live = false;
      latestRequestId += 1;
    },
  };
}

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

export type ProvisionalPageOrganizerUpload = {
  type: "provisional";
  uploadId: number;
} & PageOrganizerUploadReceipt;

type PendingPageOrganizerUpload = Extract<
  PageOrganizerUploadOutcome,
  { type: "pending" }
>;

/** Owns upload identity so an obsolete async result cannot become committable. */
export function createPageOrganizerUploadOwner() {
  let nextUploadId = 0;
  let current:
    PageOrganizerUploadOutcome | ProvisionalPageOrganizerUpload | null = null;

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
      if (current?.type === "pending" || current?.type === "provisional") {
        current = { type: "cancelled", uploadId: current.uploadId };
      }
    },
    prepareCompletion(
      pending: PendingPageOrganizerUpload,
      receipt: PageOrganizerUploadReceipt,
    ): PageOrganizerUploadOutcome | ProvisionalPageOrganizerUpload {
      if (current !== pending) {
        return current?.uploadId === pending.uploadId
          ? current
          : { type: "superseded", uploadId: pending.uploadId };
      }
      const provisional = {
        type: "provisional",
        uploadId: pending.uploadId,
        entityVersionId: receipt.entityVersionId,
        fileId: receipt.fileId,
      } as const;
      current = provisional;
      return provisional;
    },
    commit(
      provisional: ProvisionalPageOrganizerUpload,
    ): PageOrganizerUploadOutcome {
      if (current !== provisional) {
        return current?.uploadId === provisional.uploadId &&
          current.type !== "provisional"
          ? current
          : { type: "superseded", uploadId: provisional.uploadId };
      }
      const completed = {
        type: "completed",
        uploadId: provisional.uploadId,
        entityVersionId: provisional.entityVersionId,
        fileId: provisional.fileId,
      } as const;
      current = completed;
      return completed;
    },
    fail(
      pending: PendingPageOrganizerUpload,
      error: unknown,
    ): PageOrganizerUploadOutcome {
      if (current !== pending) {
        return current?.uploadId === pending.uploadId &&
          current.type !== "provisional"
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
  operation: LiveOrganizerOperation,
  owner: PageOrganizerOperationOwner,
  upload: CompletedPageOrganizerUpload,
  commit: (upload: CompletedPageOrganizerUpload) => T,
): T | null {
  if (!owner.isLive(operation)) {
    return null;
  }
  return commit(upload);
}
