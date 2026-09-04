import { api } from "@/lib/api";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";

import { completeEntityVersionUpload } from "./upload-entity-version.logic";

// Stall ceiling, not a target duration: a healthy slow upload of a large file
// can legitimately take several minutes.
const UPLOAD_PUT_TIMEOUT_MS = 30 * 60 * 1000;

type UploadEntityVersionOptions = {
  workspaceId: string;
  entityId: string;
  file: File;
  signal?: AbortSignal | undefined;
};

const hashFileSha256Hex = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const abortUpload = async (
  workspaceId: string,
  uploadId: string,
): Promise<void> => {
  try {
    // Best-effort cleanup; the storage lifecycle and pending-upload prune
    // reclaim abandoned staging objects if this request also fails.
    const response = await api
      .uploads({ workspaceId: toSafeId<"workspace">(workspaceId) })({
        uploadId,
      })
      .abort.post({});
    unwrapEden(response);
  } catch {
    // Preserve the original upload failure. Cleanup is intentionally best effort.
  }
};

/** Upload transformed bytes as a new version through the canonical file path. */
export const uploadEntityVersion = async ({
  workspaceId,
  entityId,
  file,
  signal,
}: UploadEntityVersionOptions): Promise<void> => {
  signal?.throwIfAborted();
  const sha256Hex = await hashFileSha256Hex(file);
  signal?.throwIfAborted();

  const wsClient = api.uploads({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });
  const presign = await wsClient.presign.post(
    {
      purpose: "entity_version",
      entityId: toSafeId<"entity">(entityId),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      sha256Hex,
    },
    signal ? { fetch: { signal } } : undefined,
  );
  const { uploadId, url, headers } = unwrapEden(presign);

  await completeEntityVersionUpload({
    abort: async () => await abortUpload(workspaceId, uploadId),
    finalize: async () => {
      const response = await wsClient({ uploadId }).finalize.post(
        undefined,
        signal ? { fetch: { signal } } : undefined,
      );
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    put: async () =>
      await fetchWithTimeout(url, {
        method: "PUT",
        headers,
        body: file,
        signal,
        timeoutMs: UPLOAD_PUT_TIMEOUT_MS,
      }),
  });
};
