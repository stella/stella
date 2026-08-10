import { queryOptions } from "@tanstack/react-query";
import * as v from "valibot";

import type {
  AuthoredDocumentPropertyKey,
  EmailTextAttachmentCharset,
} from "@stll/api-contract";
import { DOCUMENT_PROPERTIES_RESULT_SCHEMA } from "@stll/api-contract";

import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { APIError, shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import type {
  EmailCitationBlock,
  EmailCitationSource,
} from "@/lib/files/email-citations";
import type { EmailBodyFold } from "@/lib/files/email-preview";
import {
  fileContentQueryKey,
  fileMetadataQueryKey,
  filesQueryRoot,
  type FileMetadataQueryKey,
} from "@/lib/files/file-metadata-query.logic";
import { fetchStorageArrayBuffer } from "@/lib/files/storage-fetch";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

type FileByFieldIdKey = FileMetadataQueryKey;

type FileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

export type EmailAttachmentDescriptor = {
  charset: EmailTextAttachmentCharset | null;
  id: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  previewable: boolean;
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
  source: EmailCitationSource;
};

type TextFileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  text: string;
};

const EMAIL_ATTACHMENT_SAVE_RESPONSE_SCHEMA = v.object({
  entityId: v.string(),
  fieldId: v.string(),
  fileName: v.string(),
  workspaceId: v.string(),
});

export const filesKeys = {
  all: filesQueryRoot,
  byFieldId: fileContentQueryKey,
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

type FileOptionsProps = QueryOptionsInput<FileByFieldIdKey>;

export const fileOptions = (props: FileOptionsProps) =>
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

      const data = unwrapEden(response);

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
  });

export const emailHtmlPreviewOptions = (props: FileOptionsProps) =>
  queryOptions({
    queryKey: filesKeys.emailHtmlByFieldId(props),
    queryFn: async ({ signal }) => {
      const response = await api
        .files({ workspaceId: props.workspaceId })
        ["email-html"]({ fieldId: props.fieldId })
        .get({ fetch: { signal } });

      const data = unwrapEden(response);

      return {
        subject: data.subject,
        from: data.from,
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        date: data.date,
        attachments: data.attachments,
        bodyFolds: data.bodyFolds,
        bodyHtml: data.bodyHtml,
        citationBlocks: data.citationBlocks,
        source: data.source,
      } satisfies EmailHtmlPreviewData;
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
      const response = await api
        .files({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["office-citation"]({ entityId: toSafeId<"entity">(entityId) })({
          fieldId: toSafeId<"field">(fieldId),
        })({ blockId })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    retry: shouldRetryAPIRequest,
  });

export const emailAttachmentPreviewUrl = ({
  attachmentId,
  fieldId,
  workspaceId,
}: FileOptionsProps & { attachmentId: string }): string =>
  apiUrl(
    `/files/${encodeURIComponent(workspaceId)}/email-attachment/${encodeURIComponent(fieldId)}/${encodeURIComponent(attachmentId)}?disposition=inline`,
  );

export const emailAttachmentPreviewOptions = ({
  attachmentId,
  fieldId,
  workspaceId,
}: FileOptionsProps & { attachmentId: string }) =>
  queryOptions({
    enabled: attachmentId.length > 0,
    gcTime: 0,
    retry: false,
    staleTime: 0,
    queryKey: [
      ...filesKeys.emailHtmlByFieldId({ fieldId, workspaceId }),
      "attachment-preview",
      attachmentId,
    ],
    queryFn: async ({ signal }) => {
      const response = await fetchWithTimeout(
        emailAttachmentPreviewUrl({ attachmentId, fieldId, workspaceId }),
        { credentials: "include", signal, timeoutMs: 60_000 },
      );
      if (!response.ok) {
        throw new APIError({
          status: response.status,
          message: "Failed to preview email attachment",
        });
      }
      return await response.arrayBuffer();
    },
  });

export const saveEmailAttachment = async ({
  attachmentId,
  destinationWorkspaceId,
  fieldId,
  parentId,
  sourceWorkspaceId,
}: {
  attachmentId: string;
  destinationWorkspaceId: string;
  fieldId: string;
  parentId: string | null;
  sourceWorkspaceId: string;
}) => {
  const response = await fetchWithTimeout(
    apiUrl(
      `/files/${encodeURIComponent(sourceWorkspaceId)}/email-attachment/${encodeURIComponent(fieldId)}/${encodeURIComponent(attachmentId)}/save`,
    ),
    {
      body: JSON.stringify({
        destinationWorkspaceId,
        parentId,
      }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
      timeoutMs: 60_000,
    },
  );
  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: "Failed to save email attachment",
    });
  }
  const parsed = v.safeParse(
    EMAIL_ATTACHMENT_SAVE_RESPONSE_SCHEMA,
    await response.json(),
  );
  if (!parsed.success) {
    throw new APIError({
      status: 502,
      message: "Invalid email attachment save response",
    });
  }
  return parsed.output;
};

/**
 * The file's own embedded properties (DOCX Author and Company, PDF Producer,
 * ...). The server parses them per request from the stored bytes, so this is
 * deliberately lazy: it runs when the metadata panel is on screen, and the
 * answer then stays cached for the session.
 */
export const readDocumentProperties = async ({
  workspaceId,
  fieldId,
  signal,
}: FileOptionsProps & { signal: AbortSignal }) => {
  const response = await fetchWithTimeout(
    apiUrl(
      `/files/${encodeURIComponent(workspaceId)}/document-properties/${encodeURIComponent(fieldId)}`,
    ),
    { credentials: "include", signal, timeoutMs: 30_000 },
  );
  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: "Failed to read document properties",
    });
  }
  const parsed = v.safeParse(
    DOCUMENT_PROPERTIES_RESULT_SCHEMA,
    await response.json(),
  );
  if (!parsed.success) {
    throw new APIError({
      status: 502,
      message: "Invalid document properties response",
    });
  }
  return parsed.output;
};

export const updateDocumentProperty = async ({
  workspaceId,
  fieldId,
  propertyKey,
  value,
}: FileOptionsProps & {
  propertyKey: AuthoredDocumentPropertyKey;
  value: string;
}): Promise<void> => {
  const response = await fetchWithTimeout(
    apiUrl(
      `/files/${encodeURIComponent(workspaceId)}/document-properties/${encodeURIComponent(fieldId)}`,
    ),
    {
      body: JSON.stringify({ [propertyKey]: value }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "PATCH",
      timeoutMs: 60_000,
    },
  );
  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: "Failed to update document properties",
    });
  }
};

export const textFileOptions = (props: FileOptionsProps) =>
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

      const data = unwrapEden(response);

      const buffer = await fetchStorageArrayBuffer(data.presignedUrl, {
        signal,
        purpose: "download",
      });

      return {
        fileId: data.fileId,
        fileName: data.fileName,
        mimeType: data.mimeType,
        originalMimeType: data.originalMimeType,
        text: new TextDecoder().decode(buffer),
      } satisfies TextFileData;
    },
  });
