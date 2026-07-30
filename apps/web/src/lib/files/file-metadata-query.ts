import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";

export type StorageFetchPurpose = "display" | "download" | "native-display";

export type FileMetadataQueryKey = {
  workspaceId: string;
  fieldId: string;
  purpose?: StorageFetchPurpose;
};

type FileMetadataOptions = FileMetadataQueryKey & { enabled?: boolean };

type FileMetadata = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
};

export const fileMetadataQueryKey = (key: FileMetadataQueryKey) => [
  "files",
  "metadata",
  key.workspaceId,
  key.fieldId,
  key.purpose ?? "display",
];

export const fileMetadataOptions = (props: FileMetadataOptions) =>
  queryOptions({
    queryKey: fileMetadataQueryKey(props),
    enabled: props.enabled ?? true,
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }) => {
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
  });

export const prefetchFileMetadata = async (
  queryClient: QueryClient,
  props: FileMetadataQueryKey,
) => {
  await queryClient.prefetchQuery(fileMetadataOptions(props));
};
