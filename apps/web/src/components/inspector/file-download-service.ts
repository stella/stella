import { Result } from "better-result";

import {
  getPdfDownloadFileName,
  type DownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import { getTranslator } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** The API path that builds each rendition the server assembles per request. */
const BUILT_RENDITION_PATH = {
  reference: "stamped",
  scrubbed: "scrubbed",
} as const;

type BuiltRendition = keyof typeof BUILT_RENDITION_PATH;

type DownloadTabFileProps = {
  fieldId: string;
  fileName: string;
  /** Which copy to hand over; `getDownloadRenditions` lists the alternatives. */
  variant: DownloadVariant;
  workspaceId: string;
  onError: (message: string) => void;
};

/**
 * A rendition the API builds from the stored bytes, as a Blob. Served by the
 * API rather than by a presigned storage URL because those bytes exist only
 * per request, and fetched directly rather than through the treaty client,
 * which text-decodes every non-JSON body except `application/octet-stream` and
 * would mangle the DOCX.
 *
 * Returns null on every failure: the endpoint refuses a file it cannot build
 * (encrypted, too large, no reference on the version) the same way it refuses
 * a transport error, and no caller acts differently on the reason.
 */
export const fetchBuiltFile = async ({
  fieldId,
  rendition,
  workspaceId,
}: {
  fieldId: string;
  rendition: BuiltRendition;
  workspaceId: string;
}): Promise<Blob | null> => {
  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(
          `/files/${encodeURIComponent(workspaceId)}/${BUILT_RENDITION_PATH[rendition]}/${encodeURIComponent(fieldId)}`,
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

const isBuiltRendition = (
  variant: DownloadVariant,
): variant is BuiltRendition =>
  variant === "reference" || variant === "scrubbed";

/**
 * Downloads one field's file in the requested copy: the uploaded original and
 * the stored PDF conversion through a presigned URL, the reference and
 * metadata-free copies from the API that builds them. Every download entry
 * point goes through here, so the inspector header and the matter row menu
 * cannot hand over different bytes for the same choice.
 */
export const downloadTabFile = async ({
  fieldId,
  fileName,
  variant,
  workspaceId,
  onError,
}: DownloadTabFileProps) => {
  const t = getTranslator();

  if (isBuiltRendition(variant)) {
    const blob = await fetchBuiltFile({
      fieldId,
      rendition: variant,
      workspaceId,
    });
    if (blob === null) {
      // The scrubbed copy fails for its own reason — the file kept metadata
      // the server could not remove — and the user's next step differs.
      onError(
        t(
          variant === "scrubbed"
            ? "workspaces.files.scrubFailed"
            : "workspaces.files.downloadFailed",
        ),
      );
      return;
    }
    downloadFile(blob, fileName);
    return;
  }

  const downloadFailed = t("workspaces.files.downloadFailed");
  const asPdf = variant === "pdf";
  const response = await api
    .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
    .url({ fieldId: toSafeId<"field">(fieldId) })
    .get({ query: { purpose: asPdf ? "display" : "download" } });

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

  downloadFile(
    downloaded.value,
    asPdf ? getPdfDownloadFileName(fileName) : fileName,
  );
};
