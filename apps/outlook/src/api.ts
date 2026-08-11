import { Result, TaggedError } from "better-result";

import {
  DOCUMENT_UPLOAD_POLICY,
  type OutlookIngestionDiagnostic,
} from "@stll/api-contract";
import type { SafeId } from "@stll/api/types";
import { toSafeId } from "@stll/api/types";

import { api, withTimeout } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/api-error";
import { buildEmlFile } from "@/lib/eml";
import {
  diagnosticBase,
  ingestionDiagnostic,
} from "@/lib/ingestion-diagnostics";
import type {
  AbortingEmailUpload,
  FinalizingEmailUpload,
  IngestEmailResult,
  PendingEmailUpload,
  ReservedEmailUpload,
  UploadingEmailUpload,
} from "@/ingestion-state";
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
  const response = await api.workspaces.get(withTimeout());
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data.workspaces.map((workspace) => ({
    clientName: workspace.client?.displayName ?? null,
    id: workspace.id,
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
  const existing = await api.properties({ workspaceId }).get(withTimeout());
  if (existing.error) {
    throw toAPIError(existing.error);
  }
  const fileProperty = existing.data.find(
    (property) => property.content.type === "file",
  );
  if (fileProperty) {
    return fileProperty.id;
  }

  const created = await api.properties({ workspaceId }).put(
    {
      contentType: "file",
      name: EMAIL_FILE_PROPERTY_NAME,
      toolType: "manual-input",
    },
    withTimeout(),
  );
  if (created.error) {
    throw toAPIError(created.error);
  }
  return created.data.id;
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
  const aborted = await api
    .uploads({ workspaceId })({ uploadId })
    .abort.post(diagnostic ? { diagnostic } : {}, withTimeout());
  if (aborted.error) {
    throw toAPIError(aborted.error);
  }
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
}): Promise<ReservedEmailUpload> => {
  const workspaceId = toSafeId<"workspace">(workspaceIdString);
  const propertyId = await ensureFileProperty(workspaceId);

  const eml = await buildEmlFile({ snapshot, attachments });
  const sha256 = await sha256Hex(eml);

  const presign = await api.uploads({ workspaceId }).presign.post(
    {
      mimeType: "message/rfc822",
      name: eml.name,
      parentId: null,
      propertyId,
      purpose: "email_ingest",
      sha256Hex: sha256,
      size: eml.size,
      diagnostic,
    },
    withTimeout(),
  );
  if (presign.error) {
    throw toAPIError(presign.error);
  }

  return {
    diagnostic,
    eml,
    headers: presign.data.headers,
    skippedAttachments: attachments
      .filter((attachment) => attachment.type === "skipped")
      .map((attachment) => attachment.reason),
    type: "reserved",
    uploadId: presign.data.uploadId,
    url: presign.data.url,
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
  const finalize = await api
    .uploads({ workspaceId })({ uploadId })
    .finalize.post(
      { diagnostic, queryKey: entitiesQueryKey(workspaceId) },
      withTimeout(EMAIL_FINALIZE_TIMEOUT_MS),
    );
  if (finalize.error) {
    throw toAPIError(finalize.error);
  }

  const result = finalize.data.finalizedResult;
  if (result.type !== "email_ingest") {
    throw new APIError({
      message: `Unexpected upload result: ${result.type}`,
      status: 500,
    });
  }

  return {
    attachmentCount: result.attachmentEntityIds.length,
    entityId: result.entityId,
    fieldId: result.fieldId,
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
  const response = await api
    .uploads({ workspaceId: pending.workspaceId })({
      uploadId: pending.uploadId,
    })
    .reconcile.post({ diagnostic: pending.diagnostic }, withTimeout());
  if (response.error) {
    throw toAPIError(response.error);
  }
  switch (response.data.state) {
    case "reserved":
      return { state: "reserved" };
    case "finalizing":
      return { state: "finalizing" };
    case "retryable":
      return { reason: response.data.reason, state: "retryable" };
    case "rejected":
      return { reason: response.data.reason, state: "rejected" };
    case "complete": {
      const result = response.data.finalizedResult;
      if (result.type !== "email_ingest") {
        throw new APIError({
          message: `Unexpected upload result: ${result.type}`,
          status: 500,
        });
      }
      return {
        result: {
          attachmentCount: result.attachmentEntityIds.length,
          entityId: result.entityId,
          fieldId: result.fieldId,
          skippedAttachments:
            pending.type === "aborting" ? [] : pending.skippedAttachments,
          workspaceId: pending.workspaceId,
        },
        state: "complete",
      };
    }
  }
};

const SERVER_ERROR_STATUS = 500;

export const shouldRetainPendingEmailUpload = (error: unknown): boolean =>
  !(error instanceof APIError) ||
  error.status === 409 ||
  error.status >= SERVER_ERROR_STATUS;

export { APIError };
