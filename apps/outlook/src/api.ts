import { Result, TaggedError, panic } from "better-result";

import {
  DOCUMENT_UPLOAD_POLICY,
  parseOutlookFinalizeResponse,
  parseOutlookPropertiesResponse,
  parseOutlookPropertyCreatedResponse,
  parseOutlookPresignResponse,
  parseOutlookReconcileResponse,
  parseOutlookWorkspacesResponse,
  type SafeId,
  type OutlookIngestionDiagnostic,
} from "@stll/api-contract";
import { toSafeId } from "@stll/api-contract/safe-id";

import type {
  AbortingEmailUpload,
  FinalizingEmailUpload,
  IngestEmailResult,
  PendingEmailUpload,
  ReservedEmailUpload,
  UploadingEmailUpload,
} from "@/ingestion-state";
import { requestOutlookApi } from "@/lib/api";
import { APIError } from "@/lib/api-error";
import { buildEmlFile } from "@/lib/eml";
import {
  diagnosticBase,
  ingestionDiagnostic,
} from "@/lib/ingestion-diagnostics";
import { OutlookError } from "@/lib/outlook-error";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  WorkspaceSummary,
} from "@/types";

// Emails land under the same workspace file property regular document
// uploads use; the API does not provision one, so look it up (or create
// it once) the way the web upload flow does.
const EMAIL_FILE_PROPERTY_NAME = "Documents";
const EMAIL_FINALIZE_TIMEOUT_MS = 120_000;

const entitiesQueryKey = (workspaceId: SafeId<"workspace">) => [
  "entities",
  workspaceId,
];
export const readWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await requestOutlookApi({
    parse: parseOutlookWorkspacesResponse,
    path: "/workspaces",
  });
  return response.workspaces.map((workspace) => ({
    clientName: workspace.client?.displayName ?? null,
    id: toSafeId<"workspace">(workspace.id),
    lastActivityAt: workspace.lastActivityAt,
    name: workspace.name,
    reference: workspace.reference,
  }));
};

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const ensureFileProperty = async (
  workspaceId: SafeId<"workspace">,
): Promise<SafeId<"property">> => {
  const existing = await requestOutlookApi({
    parse: parseOutlookPropertiesResponse,
    path: `/properties/${encodeURIComponent(workspaceId)}`,
  });
  const fileProperty = existing.find(
    (property) => property.content.type === "file",
  );
  if (fileProperty) {
    return toSafeId<"property">(fileProperty.id);
  }

  const created = await requestOutlookApi({
    body: {
      contentType: "file",
      name: EMAIL_FILE_PROPERTY_NAME,
      toolType: "manual-input",
    },
    method: "PUT",
    parse: parseOutlookPropertyCreatedResponse,
    path: `/properties/${encodeURIComponent(workspaceId)}`,
  });
  return toSafeId<"property">(created.id);
};

type PendingEmailUploadIdentity = {
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

export class PendingUploadCleanupError extends TaggedError(
  "PendingUploadCleanupError",
)<{
  message: string;
  pendingUpload: PendingEmailUploadIdentity & { type: "aborting" };
  status: number;
}> {}

type DirectEmailUploadDependencies = {
  abortReservation: (
    workspaceId: SafeId<"workspace">,
    uploadId: SafeId<"pendingUpload">,
    diagnostic?: OutlookIngestionDiagnostic,
  ) => Promise<void>;
  put: (url: string, init: RequestInit) => Promise<Response>;
};

export const abortEmailUploadReservation = async (
  workspaceId: SafeId<"workspace">,
  uploadId: SafeId<"pendingUpload">,
  diagnostic?: OutlookIngestionDiagnostic,
): Promise<void> => {
  await requestOutlookApi({
    body: diagnostic ? { diagnostic } : {},
    method: "POST",
    parse: () => ({ output: undefined, success: true }),
    path: `/uploads/${encodeURIComponent(workspaceId)}/${encodeURIComponent(uploadId)}/abort`,
  });
};

const directEmailUploadDependencies: DirectEmailUploadDependencies = {
  abortReservation: abortEmailUploadReservation,
  put: fetch,
};

type PutPresignedEmailOptions = {
  abortDiagnostic?: OutlookIngestionDiagnostic;
  eml: File;
  headers: Record<string, string>;
  onAbortComplete?: () => void;
  uploadId: SafeId<"pendingUpload">;
  url: string;
  workspaceId: SafeId<"workspace">;
  onAbortStart?: () => void;
};

export const putPresignedEmail = async (
  {
    abortDiagnostic,
    eml,
    headers,
    onAbortComplete,
    onAbortStart,
    uploadId,
    url,
    workspaceId,
  }: PutPresignedEmailOptions,
  dependencyOverrides: Partial<DirectEmailUploadDependencies> = {},
): Promise<void> => {
  const dependencies = {
    ...directEmailUploadDependencies,
    ...dependencyOverrides,
  };
  const putResult = await Result.tryPromise({
    try: async () =>
      await dependencies.put(url, {
        body: eml,
        headers,
        method: "PUT",
        signal: AbortSignal.timeout(DOCUMENT_UPLOAD_POLICY.putTimeoutMs),
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(putResult) && putResult.value.ok) {
    return;
  }

  onAbortStart?.();
  const abortResult = await Result.tryPromise({
    try: async () =>
      await dependencies.abortReservation(
        workspaceId,
        uploadId,
        abortDiagnostic,
      ),
    catch: (cause) => cause,
  });
  const status = Result.isOk(putResult) ? putResult.value.status : 502;
  if (Result.isError(abortResult)) {
    throw new PendingUploadCleanupError({
      message: "Upload failed; reservation cleanup could not be confirmed",
      pendingUpload: { type: "aborting", uploadId, workspaceId },
      status,
    });
  }
  onAbortComplete?.();

  const responseSuffix = Result.isOk(putResult) ? ` (${status})` : "";
  throw new APIError({
    message: `Upload failed${responseSuffix}`,
    status,
  });
};

/**
 * Reconstruct the message as a single `.eml`, then reserve the standard
 * presigned flow with the `email_ingest` purpose. The caller stores the
 * returned identity before starting the direct PUT.
 */
export const reserveEmailUpload = async ({
  attachments,
  diagnostic,
  snapshot,
  workspaceId: workspaceIdString,
}: {
  attachments: AttachmentDownloadResult[];
  diagnostic: OutlookIngestionDiagnostic;
  snapshot: MailSnapshot;
  workspaceId: string;
}): Promise<FinalizingEmailUpload | ReservedEmailUpload> => {
  const workspaceId = toSafeId<"workspace">(workspaceIdString);
  const propertyId = await ensureFileProperty(workspaceId);

  const eml = await buildEmlFile({ snapshot, attachments });
  const sha256 = await sha256Hex(eml);
  if (!snapshot.userEmail || !snapshot.sourceId) {
    throw new OutlookError({
      code: "source-identity-unavailable",
      message: "Outlook source identity is unavailable.",
    });
  }
  const source = {
    mailboxEmail: snapshot.userEmail,
    sourceId: snapshot.sourceId,
  };

  const presign = await requestOutlookApi({
    body: {
      mimeType: "message/rfc822",
      name: eml.name,
      parentId: null,
      propertyId,
      purpose: "email_ingest",
      sha256Hex: sha256,
      size: eml.size,
      source,
      diagnostic,
    },
    method: "POST",
    parse: parseOutlookPresignResponse,
    path: `/uploads/${encodeURIComponent(workspaceId)}/presign`,
  });

  if (presign.state === "existing") {
    return {
      diagnostic,
      skippedAttachments: attachments
        .filter((attachment) => attachment.type === "skipped")
        .map((attachment) => attachment.reason),
      sourceItemInstanceKey: snapshot.itemInstanceKey,
      type: "finalizing",
      uploadId: toSafeId<"pendingUpload">(presign.uploadId),
      workspaceId,
    };
  }

  return {
    diagnostic,
    eml,
    headers: presign.headers,
    skippedAttachments: attachments
      .filter((attachment) => attachment.type === "skipped")
      .map((attachment) => attachment.reason),
    sourceItemInstanceKey: snapshot.itemInstanceKey,
    type: "reserved",
    uploadId: toSafeId<"pendingUpload">(presign.uploadId),
    url: presign.url,
    workspaceId,
  };
};

type UploadReservedEmailOptions = {
  onAborted: () => void;
  onAborting: (upload: AbortingEmailUpload) => void;
};

export const uploadReservedEmail = async (
  upload: UploadingEmailUpload,
  { onAborted, onAborting }: UploadReservedEmailOptions,
): Promise<FinalizingEmailUpload> => {
  const aborting: AbortingEmailUpload = {
    diagnostic: ingestionDiagnostic(
      diagnosticBase(upload.diagnostic),
      "abort",
      "in_progress",
    ),
    sourceItemInstanceKey: upload.sourceItemInstanceKey,
    type: "aborting",
    uploadId: upload.uploadId,
    workspaceId: upload.workspaceId,
  };
  await putPresignedEmail({
    abortDiagnostic: aborting.diagnostic,
    eml: upload.eml,
    headers: upload.headers,
    onAbortComplete: onAborted,
    onAbortStart: () => onAborting(aborting),
    uploadId: upload.uploadId,
    url: upload.url,
    workspaceId: upload.workspaceId,
  });

  return {
    diagnostic: ingestionDiagnostic(
      diagnosticBase(upload.diagnostic),
      "finalize",
      "in_progress",
    ),
    skippedAttachments: upload.skippedAttachments,
    sourceItemInstanceKey: upload.sourceItemInstanceKey,
    type: "finalizing",
    uploadId: upload.uploadId,
    workspaceId: upload.workspaceId,
  };
};

export const finalizeEmailUpload = async ({
  diagnostic,
  skippedAttachments,
  uploadId,
  workspaceId,
}: FinalizingEmailUpload): Promise<IngestEmailResult> => {
  const finalize = await requestOutlookApi({
    body: { diagnostic, queryKey: entitiesQueryKey(workspaceId) },
    method: "POST",
    parse: parseOutlookFinalizeResponse,
    path: `/uploads/${encodeURIComponent(workspaceId)}/${encodeURIComponent(uploadId)}/finalize`,
    timeoutMs: EMAIL_FINALIZE_TIMEOUT_MS,
  });

  const result = finalize.finalizedResult;

  return {
    attachmentCount: result.attachmentEntityIds.length,
    entityId: toSafeId<"entity">(result.entityId),
    fieldId: toSafeId<"field">(result.fieldId),
    skippedAttachments,
    workspaceId,
  };
};

export type EmailUploadReconciliation =
  | { state: "reserved" }
  | { state: "finalizing" }
  | { reason: string; state: "retryable" }
  | { reason: string; state: "rejected" }
  | { result: IngestEmailResult; state: "complete" };

export const reconcileEmailUpload = async (
  pending: PendingEmailUpload,
): Promise<EmailUploadReconciliation> => {
  const reconciliation = await requestOutlookApi({
    body: { diagnostic: pending.diagnostic },
    method: "POST",
    parse: parseOutlookReconcileResponse,
    path: `/uploads/${encodeURIComponent(pending.workspaceId)}/${encodeURIComponent(pending.uploadId)}/reconcile`,
  });
  switch (reconciliation.state) {
    case "reserved":
      return { state: "reserved" };
    case "finalizing":
      return { state: "finalizing" };
    case "retryable":
      return { reason: reconciliation.reason, state: "retryable" };
    case "rejected":
      return { reason: reconciliation.reason, state: "rejected" };
    case "complete": {
      const result = reconciliation.finalizedResult;
      return {
        result: {
          attachmentCount: result.attachmentEntityIds.length,
          entityId: toSafeId<"entity">(result.entityId),
          fieldId: toSafeId<"field">(result.fieldId),
          skippedAttachments:
            pending.type === "aborting" ? [] : pending.skippedAttachments,
          workspaceId: pending.workspaceId,
        },
        state: "complete",
      };
    }
    default:
      return panic("Unknown Outlook upload reconciliation state");
  }
};

const SERVER_ERROR_STATUS = 500;

export const shouldRetainPendingEmailUpload = (error: unknown): boolean =>
  !(error instanceof APIError) ||
  error.status === 409 ||
  error.status >= SERVER_ERROR_STATUS;

export { APIError };
