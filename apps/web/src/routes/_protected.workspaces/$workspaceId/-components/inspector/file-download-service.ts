import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

export type DownloadTabFileProps = {
  fieldId: string;
  fileName: string;
  workspaceId: string;
  onError: (message: string) => void;
};

// Pulls a presigned URL for the file behind this tab's field and
// downloads the original (DOCX, PDF, etc.) — same path the row
// actions use, just exposed in the inspector header so users have
// a one-click download next to Edit / Full view.
export const downloadTabOriginalFile = async ({
  fieldId,
  fileName,
  workspaceId,
  onError,
}: DownloadTabFileProps) => {
  const response = await api
    .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
    .url({ fieldId: toSafeId<"field">(fieldId) })
    .get({ query: { purpose: "download" } });

  if (response.error) {
    onError(toAPIError(response.error).message);
    return;
  }

  const fetched = await fetch(response.data.presignedUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!fetched.ok) {
    onError(`Download failed (HTTP ${fetched.status}).`);
    return;
  }

  downloadFile(await fetched.blob(), fileName);
};
