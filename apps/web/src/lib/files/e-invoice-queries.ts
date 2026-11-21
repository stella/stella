import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { eInvoicePreviewSchema } from "@stll/api-contract/e-invoice";
import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import { fetchWithTimeout } from "@stll/fetch";
import {
  readBodyJsonWithIdleDeadline,
  readBodyWithIdleDeadline,
} from "@stll/fetch/body-reader";

import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { type ApiResponse, unwrapApiResponse } from "@/lib/errors/api";
import type { FileMetadataQueryKey } from "@/lib/files/file-metadata-query.logic";
import { filesKeys, parseSuccessBody } from "@/lib/files/queries";
import type { QueryOptionsInput } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

// Read only by the lazily loaded invoice and signed-file viewers, so the
// invoice schema stays out of the startup bundle.

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

/**
 * One file a structured invoice embeds or packages, as its bytes. The same
 * route serves an invoice inside a signed envelope, so the CAdES viewer opens
 * its invoice's attachments through it too.
 */
export const fetchEInvoiceAttachment = async ({
  fieldId,
  index,
  workspaceId,
}: FileOptionsProps & { index: number }): Promise<Blob> => {
  const response = await fetchWithTimeout(
    apiUrl(
      `/files/${encodeURIComponent(workspaceId)}/e-invoice/${encodeURIComponent(fieldId)}/attachments/${encodeURIComponent(String(index))}`,
    ),
    {
      credentials: "include",
      timeout: { type: "headers", ms: 60_000 },
    },
  );
  let result: ApiResponse<Blob>;
  if (response.ok) {
    const bytes = await readBodyWithIdleDeadline(response, {
      idleMs: 30_000,
      maxBytes: UPLOAD_DOCUMENT_MAX_BYTES,
    });
    const buffer =
      bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : new Uint8Array(bytes).buffer;
    result = {
      data: new Blob([buffer], {
        type: response.headers.get("content-type") ?? "",
      }),
      error: null,
    };
  } else {
    const value = await readBodyJsonWithIdleDeadline(response, {
      idleMs: 30_000,
      maxBytes: 64 * 1024,
    });
    result = { data: null, error: { status: response.status, value } };
  }
  return unwrapApiResponse(result);
};
