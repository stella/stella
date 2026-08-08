import { queryOptions } from "@tanstack/react-query";

import type { DocumentPropertiesResult } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import {
  documentPropertiesQueryKey,
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
  fileId: string;
  fileName: string;
  html: string;
  mimeType: string;
  originalMimeType: string;
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
  documentPropertiesByFieldId: documentPropertiesQueryKey,
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
        fileId: data.fileId,
        fileName: data.fileName,
        html: data.html,
        mimeType: data.mimeType,
        originalMimeType: data.originalMimeType,
      } satisfies EmailHtmlPreviewData;
    },
  });

/**
 * The file's own embedded properties (DOCX Author and Company, PDF Producer,
 * ...). The server parses them per request from the stored bytes, so this is
 * deliberately lazy: it runs when the metadata panel is on screen, and the
 * answer then stays cached for the session.
 */
export const documentPropertiesOptions = (props: FileOptionsProps) =>
  queryOptions({
    queryKey: filesKeys.documentPropertiesByFieldId(props),
    queryFn: async ({ signal }): Promise<DocumentPropertiesResult> => {
      const response = await api
        .files({ workspaceId: props.workspaceId })
        ["document-properties"]({ fieldId: props.fieldId })
        .get({ fetch: { signal } });

      return unwrapEden(response);
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
