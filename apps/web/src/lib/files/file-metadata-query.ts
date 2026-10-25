import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import {
  type FileMetadataQueryKey,
  fileMetadataQueryKey,
} from "@/lib/files/file-metadata-query.logic";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

type FileMetadataOptions = FileMetadataQueryKey & { enabled?: boolean };

type FileMetadata = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
};

export const fileMetadataOptions = (props: FileMetadataOptions) =>
  resourceQueryOptions(
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
    }),
    {
      resources: [
        RESOURCE_TYPE.ENTITY,
        RESOURCE_TYPE.FIELD,
        RESOURCE_TYPE.USER_FILE,
      ],
      scope: { type: "workspace", workspaceId: props.workspaceId },
    },
  );
