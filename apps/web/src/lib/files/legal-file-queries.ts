import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { cadesPreviewSchema } from "@stll/api-contract/cades";
import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { structuredDocumentPreviewSchema } from "@stll/api-contract/structured-document";
import { fetchWithTimeout } from "@stll/fetch";
import {
  readBodyJsonWithIdleDeadline,
  readBodyWithIdleDeadline,
} from "@stll/fetch/body-reader";

import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { PDF_MIME } from "@/lib/consts";
import { type ApiResponse, unwrapApiResponse } from "@/lib/errors/api";
import {
  type FileOptionsProps,
  filesKeys,
  parseSuccessBody,
} from "@/lib/files/queries";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

// Only the legal file viewers, each a lazy chunk, read these, so none of it
// loads at startup.

/** An audited PDF the API derives from a signed file, read within the upload limit. */
const fetchDerivedPdf = async (path: `/${string}`, signal: AbortSignal) => {
  const response = await fetchWithTimeout(apiUrl(path), {
    credentials: "include",
    signal,
    timeout: { type: "headers", ms: 60_000 },
  });
  let result: ApiResponse<ArrayBuffer>;
  if (!response.ok) {
    const value = await readBodyJsonWithIdleDeadline(response, {
      idleMs: 30_000,
      maxBytes: 64 * 1024,
      signal,
    });
    result = { data: null, error: { status: response.status, value } };
  } else if (response.headers.get("content-type") !== PDF_MIME) {
    await Promise.allSettled([response.body?.cancel()]);
    result = {
      data: null,
      error: {
        status: 502,
        value: {
          message: "Invalid PDF response from the signed file preview",
        },
      },
    };
  } else {
    const bytes = await readBodyWithIdleDeadline(response, {
      idleMs: 30_000,
      maxBytes: UPLOAD_DOCUMENT_MAX_BYTES,
      signal,
    });
    result = {
      data:
        bytes.buffer instanceof ArrayBuffer
          ? bytes.buffer
          : new Uint8Array(bytes).buffer,
      error: null,
    };
  }
  return unwrapApiResponse(result);
};

type LegalFileKey = Pick<FileOptionsProps, "fieldId" | "workspaceId">;

const legalFileKeys = {
  cades: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "cades",
    workspaceId,
    fieldId,
  ],
  signedDossier: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "signed-dossier",
    workspaceId,
    fieldId,
  ],
};

export const signedDossierPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: legalFileKeys.signedDossier(props),
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes["signed-dossier"]({
          fieldId: props.fieldId,
        }).get({ fetch: { signal } });
        return parseSuccessBody(
          signedDossierPreviewSchema,
          unwrapApiResponse(response),
          "Signed container preview must match its response schema",
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

export const signedDossierPdfOptions = ({
  document,
  fieldId,
  workspaceId,
}: FileOptionsProps & { document: number }) =>
  resourceQueryOptions(
    // Cached like the signed file's own PDF, for the same reason.
    queryOptions({
      retry: false,
      queryKey: [
        ...legalFileKeys.signedDossier({ fieldId, workspaceId }),
        "pdf",
        document,
      ],
      queryFn: async ({ signal }) =>
        await fetchDerivedPdf(
          `/files/${encodeURIComponent(workspaceId)}/signed-dossier/${encodeURIComponent(fieldId)}/content?document=${document}`,
          signal,
        ),
    }),
    {
      resources: [
        RESOURCE_TYPE.ENTITY,
        RESOURCE_TYPE.FIELD,
        RESOURCE_TYPE.USER_FILE,
      ],
      scope: { type: "workspace", workspaceId },
    },
  );

export const asicPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: [...filesKeys.all(), "asic", props.workspaceId, props.fieldId],
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes
          .asic({
            fieldId: props.fieldId,
          })
          .get({ fetch: { signal } });
        return parseSuccessBody(
          asicPreviewSchema,
          unwrapApiResponse(response),
          "ASiC preview must match its response schema",
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
export const structuredDocumentPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: [
        ...filesKeys.all(),
        "structured-document",
        props.workspaceId,
        props.fieldId,
      ],
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes["structured-document"]({
          fieldId: props.fieldId,
        }).get({ fetch: { signal } });
        return parseSuccessBody(
          structuredDocumentPreviewSchema,
          unwrapApiResponse(response),
          "Structured document preview must match its response schema",
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
export const cadesPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: legalFileKeys.cades(props),
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes
          .cades({
            fieldId: props.fieldId,
          })
          .get({ fetch: { signal } });
        return parseSuccessBody(
          cadesPreviewSchema,
          unwrapApiResponse(response),
          "Signed file preview must match its response schema",
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

/** An audited PDF the API derives from a signed file, read within the upload limit. */
// Cached like a file's own bytes (`fileOptions`): reopening the tab reuses
// them, and with them the parsed document, instead of extracting the PDF
// from the signed container again behind a loading state.
export const cadesPdfOptions = ({ fieldId, workspaceId }: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      retry: false,
      queryKey: [...legalFileKeys.cades({ fieldId, workspaceId }), "pdf"],
      queryFn: async ({ signal }) =>
        await fetchDerivedPdf(
          `/files/${encodeURIComponent(workspaceId)}/cades/${encodeURIComponent(fieldId)}/content`,
          signal,
        ),
    }),
    {
      resources: [
        RESOURCE_TYPE.ENTITY,
        RESOURCE_TYPE.FIELD,
        RESOURCE_TYPE.USER_FILE,
      ],
      scope: { type: "workspace", workspaceId },
    },
  );
