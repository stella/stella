import { Result } from "better-result";

import type { PrimaryDownloadVariant } from "@/components/inspector/file-download-service.logic";
import { getTranslator } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

const DOWNLOAD_TIMEOUT_MS = 60_000;

type DownloadTabFileProps = {
  fieldId: string;
  fileName: string;
  /** Which copy to hand over; `resolvePrimaryDownloadVariant` decides it. */
  variant: PrimaryDownloadVariant;
  workspaceId: string;
  onError: (message: string) => void;
};

/**
 * The reference copy of a document, as bytes. Served by the API rather than
 * by a presigned storage URL because the reference footer is written into the
 * file per request, and fetched directly rather than through the treaty
 * client, which text-decodes every non-JSON body except
 * `application/octet-stream` and would mangle the DOCX.
 *
 * Returns null on every failure: the endpoint refuses a file it cannot stamp
 * (encrypted, too large, no reference on the version) the same way it refuses
 * a transport error, and no caller acts differently on the reason.
 */
export const fetchReferencedFile = async ({
  fieldId,
  workspaceId,
}: {
  fieldId: string;
  workspaceId: string;
}): Promise<Blob | null> => {
  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(
          `/files/${encodeURIComponent(workspaceId)}/stamped/${encodeURIComponent(fieldId)}`,
        ),
        { credentials: "include", timeoutMs: DOWNLOAD_TIMEOUT_MS },
      ),
  );
  if (Result.isError(responseResult) || !responseResult.value.ok) {
    return null;
  }

  const blobResult = await Result.tryPromise(
    async () => await responseResult.value.blob(),
  );
  return Result.isError(blobResult) ? null : blobResult.value;
};

// Downloads the file behind this tab's field: the reference copy where the
// document carries one, otherwise the uploaded original through a presigned
// URL. Same variants the row actions offer, exposed in the inspector header
// so users have a one-click download next to Edit / Full view.
export const downloadTabFile = async ({
  fieldId,
  fileName,
  variant,
  workspaceId,
  onError,
}: DownloadTabFileProps) => {
  const downloadFailed = getTranslator()("workspaces.files.downloadFailed");

  if (variant === "reference") {
    const blob = await fetchReferencedFile({ fieldId, workspaceId });
    if (blob === null) {
      onError(downloadFailed);
      return;
    }
    downloadFile(blob, fileName);
    return;
  }

  const response = await api
    .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
    .url({ fieldId: toSafeId<"field">(fieldId) })
    .get({ query: { purpose: "download" } });

  if (response.error) {
    onError(toAPIError(response.error).message);
    return;
  }

  const downloaded = await Result.tryPromise(async () => {
    const fetched = await fetchWithTimeout(response.data.presignedUrl, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return fetched.ok ? await fetched.blob() : null;
  });

  if (Result.isError(downloaded) || downloaded.value === null) {
    onError(downloadFailed);
    return;
  }

  downloadFile(downloaded.value, fileName);
};
