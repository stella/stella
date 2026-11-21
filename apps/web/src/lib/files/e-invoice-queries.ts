import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { eInvoicePreviewSchema } from "@stll/api-contract/e-invoice";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { FileMetadataQueryKey } from "@/lib/files/file-metadata-query.logic";
import { filesKeys, parseSuccessBody } from "@/lib/files/queries";
import type { QueryOptionsInput } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

// Read only by the lazily loaded invoice viewer, so the invoice schema stays
// out of the startup bundle. Attachment bytes are fetched in ./queries.

type FileOptionsProps = QueryOptionsInput<FileMetadataQueryKey>;

export const eInvoicePreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: [
        ...filesKeys.all(),
        "e-invoice",
        props.workspaceId,
        props.fieldId,
      ],
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes["e-invoice"]({
          fieldId: props.fieldId,
        }).get({ fetch: { signal } });
        return parseSuccessBody(
          eInvoicePreviewSchema,
          unwrapApiResponse(response),
          "Structured invoice preview must match its response schema",
        );
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
