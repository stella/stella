import { Result } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import {
  getPdfDownloadFileName,
  type DownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import { getTranslator } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/lib/utils";

const DOWNLOAD_TIMEOUT_MS = 60_000;

const BUILT_RENDITION_REQUEST = {
  reference: { path: "stamped", query: "?metadata=keep" },
  "reference-scrubbed": { path: "stamped", query: "?metadata=strip" },
  scrubbed: { path: "scrubbed", query: "" },
} as const;

type BuiltRendition = keyof typeof BUILT_RENDITION_REQUEST;

type DownloadTabFileProps = {
  fieldId: string;
  fileName: string;
  /** Which copy to hand over; `getDownloadRenditions` lists the alternatives. */
  variant: DownloadVariant;
  workspaceId: string;
  onError: (message: string, error: unknown) => void;
};

/**
 * A rendition the API builds from the stored bytes, as a Blob. Served by the
 * API rather than by a presigned storage URL because those bytes exist only
 * per request, and fetched directly rather than through the treaty client,
 * which text-decodes every non-JSON body except `application/octet-stream` and
 * would mangle the DOCX.
 *
 * Preserves typed API refusals and transport errors for the notification owner.
 */
const fetchBuiltFile = async ({
  fieldId,
  rendition,
  workspaceId,
}: {
  fieldId: string;
  rendition: BuiltRendition;
  workspaceId: string;
}) => {
  const request = BUILT_RENDITION_REQUEST[rendition];
  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(
          `/files/${encodeURIComponent(workspaceId)}/${request.path}/${encodeURIComponent(fieldId)}${request.query}`,
        ),
        { credentials: "include", timeoutMs: DOWNLOAD_TIMEOUT_MS },
      ),
  );
  if (Result.isError(responseResult)) {
    return responseResult;
  }
  if (!responseResult.value.ok) {
    const body = await Result.tryPromise(
      async () => await responseResult.value.json(),
    );
    return Result.err(
      toAPIError({
        status: responseResult.value.status,
        value: Result.isError(body) ? undefined : body.value,
      }),
    );
  }

  const blobResult = await Result.tryPromise(
    async () => await responseResult.value.blob(),
  );
  return blobResult;
};

const isBuiltRendition = (
  variant: DownloadVariant,
): variant is BuiltRendition =>
  variant === "reference" ||
  variant === "reference-scrubbed" ||
  variant === "scrubbed";

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
    const blobResult = await fetchBuiltFile({
      fieldId,
      rendition: variant,
      workspaceId,
    });
    if (Result.isError(blobResult)) {
      // The scrubbed copy fails for its own reason — the file kept metadata
      // the server could not remove — and the user's next step differs.
      onError(
        t(
          variant === "scrubbed" || variant === "reference-scrubbed"
            ? "workspaces.files.scrubFailed"
            : "workspaces.files.downloadFailed",
        ),
        blobResult.error,
      );
      return;
    }
    downloadFile(blobResult.value, fileName);
    return;
  }

  const downloadFailed = t("workspaces.files.downloadFailed");
  const asPdf = variant === "pdf";
  const response = await api
    .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
    .url({ fieldId: toSafeId<"field">(fieldId) })
    .get({ query: { purpose: asPdf ? "display" : "download" } });

  if (response.error) {
    const error = toAPIError(response.error);
    onError(error.message, error);
    return;
  }

  const downloaded = await Result.tryPromise(async () => {
    const fetched = await fetchWithTimeout(response.data.presignedUrl, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return fetched.ok ? await fetched.blob() : null;
  });

  if (Result.isError(downloaded) || downloaded.value === null) {
    onError(
      downloadFailed,
      Result.isError(downloaded) ? downloaded.error : undefined,
    );
    return;
  }

  downloadFile(
    downloaded.value,
    asPdf ? getPdfDownloadFileName(fileName) : fileName,
  );
};
