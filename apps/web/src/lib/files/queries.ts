import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import type { EmailBodyFold } from "@/lib/files/email-preview";
import {
  fileContentQueryKey,
  fileMetadataQueryKey,
  filesQueryRoot,
  type FileMetadataQueryKey,
} from "@/lib/files/file-metadata-query.logic";
import { fetchStorageArrayBuffer } from "@/lib/files/storage-fetch";
import type { QueryOptionsInput } from "@/lib/react-query";

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
  attachments: {
    id: string;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number;
    previewable: boolean;
  }[];
  bodyFolds: EmailBodyFold[];
  bodyHtml: string;
};

type TextFileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  text: string;
};

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
      } satisfies EmailHtmlPreviewData;
    },
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
