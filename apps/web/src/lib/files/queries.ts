import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import * as v from "valibot";

import type {
  AuthoredDocumentPropertyKey,
  EmailAttachmentDescriptor,
  EmailCitationBlock,
} from "@stll/api-contract";
import {
  DOCUMENT_PROPERTIES_RESULT_SCHEMA,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { CertifiedEmailEnvelope } from "@stll/api-contract/certified-email";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import {
  APIError,
  shouldRetryAPIRequest,
  unwrapApiResponse,
} from "@/lib/errors/api";
import { shareFileData } from "@/lib/files/array-buffer-utils";
import type { EmailCitationSource } from "@/lib/files/email-citations";
import type { EmailBodyFold } from "@/lib/files/email-preview";
import {
  documentPropertiesQueryKey,
  fileContentByFieldQueryRoot,
  fileContentQueryKey,
  type FileMetadataQueryKey,
  fileMetadataQueryKey,
  filesQueryRoot,
} from "@/lib/files/file-metadata-query.logic";
import { fetchStorageArrayBuffer } from "@/lib/files/storage-fetch";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

type FileByFieldIdKey = FileMetadataQueryKey;

type FileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

type EmailHtmlPreviewData = {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  date: string | null;
  attachments: EmailAttachmentDescriptor[];
  bodyFolds: EmailBodyFold[];
  bodyHtml: string;
  citationBlocks: EmailCitationBlock[];
  certified: CertifiedEmailEnvelope | null;
  source: EmailCitationSource;
};

type TextFileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  text: string;
};

// Saving an attachment copies and re-derives the file, and a property update
// rewrites it; both keep the longer bound they had before the typed client.
const FILE_WRITE_TIMEOUT_MS = 60_000;

// Route types do not validate decoded JSON: a success answer that does not
// match its contract is the same 502 it was before the typed client.
export const parseSuccessBody = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  body: unknown,
  message: string,
): v.InferOutput<TSchema> => {
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    throw new APIError({ status: 502, message });
  }
  return parsed.output;
};

export const filesKeys = {
  all: filesQueryRoot,
  byFieldId: fileContentQueryKey,
  contentByFieldId: fileContentByFieldQueryRoot,
  metadataByFieldId: fileMetadataQueryKey,
  emailHtmlByFieldId: (key: FileByFieldIdKey) => [
    ...filesKeys.all(),
    "email-html",
    key.workspaceId,
    key.fieldId,
  ],
  officeCitation: ({
    blockId,
    entityId,
    fieldId,
    workspaceId,
  }: {
    blockId: string;
    entityId: string;
    fieldId: string;
    workspaceId: string;
  }) => [
    ...filesKeys.all(),
    "office-citation",
    workspaceId,
    entityId,
    fieldId,
    blockId,
  ],
  textByFieldId: (key: FileByFieldIdKey) => [
    ...filesKeys.all(),
    "text",
    key.workspaceId,
    key.fieldId,
  ],
};

export type FileOptionsProps = QueryOptionsInput<FileByFieldIdKey>;

export const fileOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: filesKeys.byFieldId(props),
      queryFn: async ({ signal }) => {
        const response = await api
          .files({ workspaceId: props.workspaceId })
          .url({ fieldId: props.fieldId })
          .get({
            query: { purpose: props.purpose ?? "display" },
            fetch: { signal },
          });

        const data = unwrapApiResponse(response);
        // Without a `part` the endpoint answers with the file itself.
        if (data.kind !== "file") {
          return panic("The file link answered with a part");
        }

        const buffer = await fetchStorageArrayBuffer(data.presignedUrl, {
          signal,
          purpose: props.purpose ?? "display",
        });

        return {
          fileId: data.fileId,
          fileName: data.fileName,
          mimeType: data.mimeType,
          originalMimeType: data.originalMimeType,
          buffer,
        } satisfies FileData;
      },
      structuralSharing: shareFileData,
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

const withFileName =
  <T extends { fileName: string }>(fileName: string) =>
  (current: T | undefined): T | undefined =>
    current === undefined || current.fileName === fileName
      ? current
      : { ...current, fileName };

/**
 * Open previews read `fileName` off the downloaded file (every purpose
 * variant) or the decoded text, not the metadata query a rename already
 * invalidates. Patch both caches in place so the chat placeholder changes
 * with the rename instead of waiting for a byte refetch.
 */
export const replaceCachedFileName = (
  queryClient: QueryClient,
  { fieldId, fileName, workspaceId }: FileByFieldIdKey & { fileName: string },
) => {
  queryClient.setQueriesData<FileData>(
    { queryKey: filesKeys.contentByFieldId({ workspaceId, fieldId }) },
    withFileName(fileName),
  );
  queryClient.setQueryData(
    textFileOptions({ workspaceId, fieldId }).queryKey,
    withFileName<TextFileData>(fileName),
  );
};

export const dataBoxPreviewOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: [
        ...filesKeys.all(),
        "data-box",
        props.workspaceId,
        props.fieldId,
      ],
      queryFn: async ({ signal }) => {
        const fileRoutes = api.files({ workspaceId: props.workspaceId });
        const response = await fileRoutes["data-box"]({
          fieldId: props.fieldId,
        }).get({ fetch: { signal } });
        return unwrapApiResponse(response);
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

export const emailHtmlPreviewOptions = (props: FileOptionsProps) =>
  queryOptions({
    queryKey: filesKeys.emailHtmlByFieldId(props),
    queryFn: async ({ signal }) => {
      const fileRoutes = api.files({ workspaceId: props.workspaceId });
      const response = await fileRoutes["email-html"]({
        fieldId: props.fieldId,
      }).get({ fetch: { signal } });

      // The answer is the preview and its source, field for field.
      const data: EmailHtmlPreviewData = unwrapApiResponse(response);
      return data;
    },
  });

export const officeCitationOptions = ({
  blockId,
  entityId,
  fieldId,
  workspaceId,
}: {
  blockId: string;
  entityId: string;
  fieldId: string;
  workspaceId: string;
}) =>
  queryOptions({
    queryKey: filesKeys.officeCitation({
      blockId,
      entityId,
      fieldId,
      workspaceId,
    }),
    queryFn: async ({ signal }) => {
      const fileRoutes = api.files({
        workspaceId: toSafeId<"workspace">(workspaceId),
      });
      const response = await fileRoutes["office-citation"]({
        entityId: toSafeId<"entity">(entityId),
      })({
        fieldId: toSafeId<"field">(fieldId),
      })({ blockId }).get({ fetch: { signal } });
      return unwrapApiResponse(response);
    },
    retry: shouldRetryAPIRequest,
  });

type UpdateDocumentPropertyInput = FileOptionsProps & {
  propertyKey: AuthoredDocumentPropertyKey;
  value: string;
};

export const createFileWrites = (apiClient: typeof api) => ({
  updateDocumentProperty: async ({
    workspaceId,
    fieldId,
    propertyKey,
    value,
  }: UpdateDocumentPropertyInput): Promise<void> => {
    const fileRoutes = apiClient.files({ workspaceId });
    await invokeAppOnlyWrite("files.document-properties.update", async () =>
      unwrapApiResponse(
        await fileRoutes["document-properties"]({ fieldId }).patch(
          { [propertyKey]: value },
          { fetch: { timeoutMs: FILE_WRITE_TIMEOUT_MS } },
        ),
      ),
    );
  },
});

export const { updateDocumentProperty } = createFileWrites(api);

/**
 * The file's own embedded properties (DOCX Author and Company, PDF Producer,
 * ...). The server parses them per request from the stored bytes, so this is
 * deliberately lazy: it runs when the metadata panel is on screen, and the
 * answer then stays cached for the session.
 */
const readDocumentProperties = async ({
  workspaceId,
  fieldId,
  signal,
}: FileOptionsProps & { signal: AbortSignal }) => {
  const fileRoutes = api.files({ workspaceId });
  return parseSuccessBody(
    DOCUMENT_PROPERTIES_RESULT_SCHEMA,
    unwrapApiResponse(
      await fileRoutes["document-properties"]({ fieldId }).get({
        fetch: { signal },
      }),
    ),
    "Invalid document properties response",
  );
};

/**
 * Shared by the metadata panel's subscriber and the document route loader.
 * The loader-started fetch survives StrictMode's dev-only
 * subscribe/unsubscribe churn (an observer-started fetch is aborted and
 * refired), so the request runs exactly once per file.
 */
export const documentPropertiesOptions = ({
  workspaceId,
  fieldId,
}: FileOptionsProps) =>
  queryOptions({
    gcTime: Number.POSITIVE_INFINITY,
    queryKey: documentPropertiesQueryKey({ workspaceId, fieldId }),
    queryFn: async ({ signal }) =>
      await readDocumentProperties({ fieldId, signal, workspaceId }),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const textFileOptions = (props: FileOptionsProps) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: filesKeys.textByFieldId(props),
      queryFn: async ({ signal }) => {
        const response = await api
          .files({ workspaceId: props.workspaceId })
          .url({ fieldId: props.fieldId })
          .get({
            query: { purpose: "download" },
            fetch: { signal },
          });

        const data = unwrapApiResponse(response);
        // Without a `part` the endpoint answers with the file itself.
        if (data.kind !== "file") {
          return panic("The file link answered with a part");
        }

        const buffer = await fetchStorageArrayBuffer(data.presignedUrl, {
          signal,
          purpose: "download",
        });

        // Loaded with the file, not the app: the decoder carries the CLDR
        // letters it weighs an undeclared legacy charset against.
        const { decodeDeclared } =
          await import("@stll/mojibake/declared-charset");
        return {
          fileId: data.fileId,
          fileName: data.fileName,
          mimeType: data.mimeType,
          originalMimeType: data.originalMimeType,
          text: decodeDeclared(new Uint8Array(buffer), {
            contentType: data.originalMimeType,
          }).text,
        } satisfies TextFileData;
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
