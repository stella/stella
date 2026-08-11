import type { SafeId } from "@stll/api/types";
import { toSafeId } from "@stll/api/types";

import { api, withTimeout } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/api-error";
import { buildEmlFile } from "@/lib/eml";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  WorkspaceSummary,
} from "@/types";

// Emails land under the same workspace file property regular document
// uploads use; the API does not provision one, so look it up (or create
// it once) the way the web upload flow does.
const EMAIL_FILE_PROPERTY_NAME = "Documents";
const S3_UPLOAD_TIMEOUT_MS = 60_000;
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

export type IngestEmailResult = {
  attachmentCount: number;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  skippedAttachments: string[];
  workspaceId: SafeId<"workspace">;
};

export type PendingEmailUpload = {
  skippedAttachments: string[];
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Reconstruct the message as a single `.eml`, then upload it through the
 * standard presigned flow with the `email_ingest` purpose. The API parses
 * it, stores it as a message entity, and fans each attachment out into a
 * child entity. One round-trip plus the direct S3 PUT replaces the former
 * per-field / per-attachment fan-out.
 */
export const prepareEmailUpload = async ({
  attachments,
  snapshot,
  workspaceId: workspaceIdString,
}: {
  attachments: AttachmentDownloadResult[];
  snapshot: MailSnapshot;
  workspaceId: string;
}): Promise<PendingEmailUpload> => {
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
    },
    withTimeout(),
  );
  if (presign.error) {
    throw toAPIError(presign.error);
  }

  const putResponse = await fetch(presign.data.url, {
    body: eml,
    headers: presign.data.headers,
    method: "PUT",
    signal: AbortSignal.timeout(S3_UPLOAD_TIMEOUT_MS),
  });
  if (!putResponse.ok) {
    throw new APIError({
      message: `Upload failed (${putResponse.status})`,
      status: putResponse.status,
    });
  }

  return {
    skippedAttachments: attachments
      .filter((attachment) => attachment.type === "skipped")
      .map((attachment) => attachment.reason),
    uploadId: presign.data.uploadId,
    workspaceId,
  };
};

export const finalizeEmailUpload = async ({
  skippedAttachments,
  uploadId,
  workspaceId,
}: PendingEmailUpload): Promise<IngestEmailResult> => {
  const finalize = await api
    .uploads({ workspaceId })({ uploadId })
    .finalize.post(
      { queryKey: entitiesQueryKey(workspaceId) },
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

const RETRYABLE_FINALIZE_STATUS = new Set([409, 500]);

export const shouldRetainPendingEmailUpload = (error: unknown): boolean =>
  !(error instanceof APIError) || RETRYABLE_FINALIZE_STATUS.has(error.status);

export { APIError };
