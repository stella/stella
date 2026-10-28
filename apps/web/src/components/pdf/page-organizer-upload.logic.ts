import type { SafeId } from "@/lib/safe-id";

const organizerOperationBrand: unique symbol = Symbol("organizer-operation");
const organizerRequestBrand: unique symbol = Symbol("organizer-request");
const uploadOwnerBrand: unique symbol = Symbol("upload-owner");

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

/** Issues one capability per invocation and explicitly aborts superseded work. */
export function createPageOrganizerOperationOwner() {
  const operation: LiveOrganizerOperation = { [organizerOperationBrand]: true };
  let live = true;
  let latestRequestId = 0;
  const controllers = new Map<number, Set<AbortController>>();
  const abort = (requestId: number) => {
    for (const controller of controllers.get(requestId) ?? []) {
      controller.abort();
    }
    controllers.delete(requestId);
  };
  return {
    operation,
    beginRequest(candidate: LiveOrganizerOperation): OrganizerOperationRequest {
      abort(latestRequestId);
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
    ownController(
      request: OrganizerOperationRequest,
      controller: AbortController,
    ): void {
      if (!this.isCurrent(request)) {
        controller.abort();
        return;
      }
      const owned =
        controllers.get(request.requestId) ?? new Set<AbortController>();
      owned.add(controller);
      controllers.set(request.requestId, owned);
    },
    releaseController(
      request: OrganizerOperationRequest,
      controller: AbortController,
    ): void {
      const owned = controllers.get(request.requestId);
      owned?.delete(controller);
      if (owned?.size === 0) {
        controllers.delete(request.requestId);
      }
    },
    revoke(): void {
      live = false;
      for (const requestId of controllers.keys()) {
        abort(requestId);
      }
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
  | ({
      type: "completed";
      uploadId: number;
      request: OrganizerOperationRequest | null;
      owner: symbol;
      consumed: boolean;
    } & PageOrganizerUploadReceipt)
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
  request: OrganizerOperationRequest | null;
  owner: symbol;
} & PageOrganizerUploadReceipt;
type PendingPageOrganizerUpload = Extract<
  PageOrganizerUploadOutcome,
  { type: "pending" }
> & { request: OrganizerOperationRequest | null; owner: symbol };

/** Binds every receipt to the request and upload owner that produced it. */
export function createPageOrganizerUploadOwner() {
  let nextUploadId = 0;
  const owner = Symbol("page-organizer-upload-owner");
  let current:
    | PageOrganizerUploadOutcome
    | ProvisionalPageOrganizerUpload
    | PendingPageOrganizerUpload
    | null = null;
  return {
    [uploadOwnerBrand]: owner,
    begin(
      request: OrganizerOperationRequest | null = null,
    ): PendingPageOrganizerUpload {
      if (current?.type === "pending" || current?.type === "provisional") {
        current = { type: "superseded", uploadId: current.uploadId };
      }
      const pending = {
        type: "pending",
        uploadId: ++nextUploadId,
        request,
        owner,
      } as const;
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
        request: pending.request,
        owner,
        ...receipt,
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
        request: provisional.request,
        owner,
        entityVersionId: provisional.entityVersionId,
        fileId: provisional.fileId,
        consumed: false,
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
    consume<T>(
      request: OrganizerOperationRequest,
      operationOwner: PageOrganizerOperationOwner,
      receipt: CompletedPageOrganizerUpload,
      commit: (receipt: PageOrganizerUploadReceipt) => T,
    ): T | null {
      if (
        !operationOwner.isCurrent(request) ||
        receipt.request !== request ||
        receipt.owner !== owner ||
        receipt.consumed
      ) {
        return null;
      }
      receipt.consumed = true;
      return commit(receipt);
    },
  };
}

/** Consume a receipt once. New organizer code uses the upload owner's stricter consume method. */
export function commitCompletedUpload<T>(
  operation: LiveOrganizerOperation,
  owner: PageOrganizerOperationOwner,
  upload: CompletedPageOrganizerUpload,
  commit: (upload: CompletedPageOrganizerUpload) => T,
): T | null {
  if (!owner.isLive(operation) || upload.consumed) {
    return null;
  }
  upload.consumed = true;
  return commit(upload);
}
