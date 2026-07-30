import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import {
  fileMetadataQueryKey,
  type FileMetadataQueryKey,
  type StorageFetchPurpose,
} from "@/lib/files/file-metadata-query";
import type { QueryOptionsInput } from "@/lib/react-query";
import { fetchStorageArrayBuffer } from "@/routes/_protected.workspaces/$workspaceId/-components/files/storage-fetch";

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
  all: () => ["files"],
  byFieldId: (key: FileByFieldIdKey) => [
    ...filesKeys.all(),
    key.workspaceId,
    key.fieldId,
    key.purpose ?? "display",
  ],
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
        fileId: data.fileId,
        fileName: data.fileName,
        html: data.html,
        mimeType: data.mimeType,
        originalMimeType: data.originalMimeType,
      } satisfies EmailHtmlPreviewData;
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
