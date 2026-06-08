import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";

type FileByFieldIdKey = {
  workspaceId: string;
  fieldId: string;
  purpose?: "display" | "download" | "native-display";
};

type FileData = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

type FileMetadata = Omit<FileData, "buffer">;

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
  metadataByFieldId: (key: FileByFieldIdKey) => [
    ...filesKeys.all(),
    "metadata",
    key.workspaceId,
    key.fieldId,
    key.purpose ?? "display",
  ],
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

export const fileMetadataOptions = (props: FileOptionsProps) =>
  queryOptions({
    queryKey: filesKeys.metadataByFieldId(props),
    queryFn: async ({ signal }) => {
      const response = await api
        .files({ workspaceId: props.workspaceId })
        .url({ fieldId: props.fieldId })
        .get({
          query: { purpose: props.purpose ?? "display" },
          fetch: { signal },
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return {
        fileId: response.data.fileId,
        fileName: response.data.fileName,
        mimeType: response.data.mimeType,
        originalMimeType: response.data.originalMimeType,
      } satisfies FileMetadata;
    },
  });

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

      if (response.error) {
        throw toAPIError(response.error);
      }

      const file = await fetch(response.data.presignedUrl, { signal });

      if (!file.ok) {
        throw new APIError({
          status: file.status,
          message: "Failed to fetch file from storage",
        });
      }

      return {
        fileId: response.data.fileId,
        fileName: response.data.fileName,
        mimeType: response.data.mimeType,
        originalMimeType: response.data.originalMimeType,
        buffer: await file.arrayBuffer(),
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return {
        fileId: response.data.fileId,
        fileName: response.data.fileName,
        html: response.data.html,
        mimeType: response.data.mimeType,
        originalMimeType: response.data.originalMimeType,
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      const file = await fetch(response.data.presignedUrl, { signal });

      if (!file.ok) {
        throw new APIError({
          status: file.status,
          message: "Failed to fetch file from storage",
        });
      }

      return {
        fileId: response.data.fileId,
        fileName: response.data.fileName,
        mimeType: response.data.mimeType,
        originalMimeType: response.data.originalMimeType,
        text: new TextDecoder().decode(await file.arrayBuffer()),
      } satisfies TextFileData;
    },
  });
