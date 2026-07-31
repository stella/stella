import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import {
  fileMetadataQueryKey,
  type FileMetadataQueryKey,
} from "@/lib/files/file-metadata-query.logic";

export type { StorageFetchPurpose } from "@/lib/files/file-metadata-query.logic";

type FileMetadataOptions = FileMetadataQueryKey & { enabled?: boolean };

type FileMetadata = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
};

export const fileMetadataOptions = (props: FileMetadataOptions) =>
  ({
    queryKey: fileMetadataQueryKey(props),
    enabled: props.enabled ?? true,
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await api
        .files({ workspaceId: props.workspaceId })
        .url({ fieldId: props.fieldId })
        .get({
          query: { purpose: props.purpose ?? "display" },
          fetch: { signal },
        });

      const data = unwrapEden(response);

      return {
        fileId: data.fileId,
        fileName: data.fileName,
        mimeType: data.mimeType,
        originalMimeType: data.originalMimeType,
      } satisfies FileMetadata;
    },
  }) as const;
