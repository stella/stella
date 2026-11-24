import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { cadesPreviewSchema } from "@stll/api-contract/cades";
import { xmlDocumentPreviewSchema } from "@stll/api-contract/e-invoice";
import { mailboxPreviewSchema } from "@stll/api-contract/mailbox";
import { signaturePreviewSchema } from "@stll/api-contract/signature";
import { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { structuredDocumentPreviewSchema } from "@stll/api-contract/structured-document";
import { zipArchivePreviewSchema } from "@stll/api-contract/zip-archive";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import {
  type FileOptionsProps,
  filesKeys,
  parseSuccessBody,
} from "@/lib/files/queries";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

// Only the legal file viewers, each a lazy chunk, read these, so none of it
// loads at startup.

type LegalFileKey = Pick<FileOptionsProps, "fieldId" | "workspaceId">;

const legalFileKeys = {
  cades: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "cades",
    workspaceId,
    fieldId,
  ],
  signature: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "signature",
    workspaceId,
    fieldId,
  ],
  signedDossier: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "signed-dossier",
    workspaceId,
    fieldId,
  ],
  zip: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "zip",
    workspaceId,
    fieldId,
  ],
  mbox: ({ fieldId, workspaceId }: LegalFileKey) => [
    ...filesKeys.all(),
    "mbox",
    workspaceId,
    fieldId,
  ],
};

export const zipArchivePreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: legalFileKeys.zip(props),
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes
          .zip({ fieldId: props.fieldId })
          .get({ fetch: { signal } });
        return parseSuccessBody(
          zipArchivePreviewSchema,
          unwrapApiResponse(response),
          "ZIP archive preview must match its response schema",
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

export const mailboxPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: legalFileKeys.mbox(props),
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes
          .mbox({ fieldId: props.fieldId })
          .get({ fetch: { signal } });
        return parseSuccessBody(
          mailboxPreviewSchema,
          unwrapApiResponse(response),
          "Mailbox preview must match its response schema",
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
/**
 * A signature file's signers and what it signs, or `notSignature` for a
 * `.sig` file whose bytes are not a signature.
 */
export const signaturePreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: legalFileKeys.signature(props),
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes
          .signature({
            fieldId: props.fieldId,
          })
          .get({ fetch: { signal } });
        return parseSuccessBody(
          signaturePreviewSchema,
          unwrapApiResponse(response),
          "Signature preview must match its response schema",
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
          xmlDocumentPreviewSchema,
          unwrapApiResponse(response),
          "Invoice or XML preview must match its response schema",
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
