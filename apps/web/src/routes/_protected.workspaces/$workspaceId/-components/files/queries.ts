import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";

type FileOptionsProps = {
  workspaceId: string;
  fieldId: string;
};

export type FileData = {
  fileId: string;
  buffer: ArrayBuffer;
};

const filesKeys = {
  byFieldId: (props: FileOptionsProps) => [
    "files",
    props.workspaceId,
    props.fieldId,
  ],
};

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
        buffer: await file.arrayBuffer(),
      } satisfies FileData;
    },
  });
