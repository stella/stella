import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";

type FileByFieldIdKey = {
  workspaceId: string;
  fieldId: string;
};

type FileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

const filesKeys = {
  byFieldId: (key: FileByFieldIdKey) => ["files", key.workspaceId, key.fieldId],
};

type FileOptionsProps = QueryOptionsInput<FileByFieldIdKey>;

export const fileOptions = (props: FileOptionsProps) =>
  queryOptions({
    queryKey: filesKeys.byFieldId(props),
    queryFn: async ({ signal }) => {
      const response = await api
        .files({ workspaceId: props.workspaceId })
        .url({ fieldId: props.fieldId })
        .get({
          query: { purpose: "display" },
          fetch: { signal },
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const file = await fetch(response.data.presignedUrl);

      if (!file.ok) {
        throw new APIError({
          status: file.status,
          message: "Failed to fetch file from storage",
        });
      }

      return {
        fileId: response.data.fileId,
        fileName: response.data.fileName,
        mimeType: response.data.mimeType,
        originalMimeType: response.data.originalMimeType,
        buffer: await file.arrayBuffer(),
      } satisfies FileData;
    },
  });
