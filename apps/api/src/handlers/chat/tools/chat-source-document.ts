import type { FieldContent } from "@/api/db/schema-validators";

export const DEFAULT_SOURCE_DOCUMENT_KIND = "document";

export type ChatSourceDocument = {
  entityId: string;
  kind: string;
  mimeType: string | null;
  title: string;
  workspaceId: string | null;
};

type SourceDocumentField = {
  content: FieldContent;
};

type SourceDocumentFileField = {
  content: Extract<FieldContent, { type: "file" }>;
};

type GetFileMetadataProps = {
  fields?: SourceDocumentField[] | undefined;
};

type GetFileMetadataResult = {
  fileName: string | null;
  mimeType: string | null;
};

const getFileMetadata = ({
  fields,
}: GetFileMetadataProps): GetFileMetadataResult => {
  const fileField = fields?.find(
    (field): field is SourceDocumentFileField => field.content.type === "file",
  );

  if (!fileField) {
    return {
      fileName: null,
      mimeType: null,
    };
  }

  return {
    fileName: fileField.content.fileName,
    mimeType: fileField.content.mimeType,
  };
};

type BuildChatSourceDocumentProps = {
  entityId: string;
  fields?: SourceDocumentField[] | undefined;
  kind?: string | null | undefined;
  name?: string | null | undefined;
  workspaceId?: string | null | undefined;
};

export const buildChatSourceDocument = ({
  entityId,
  fields,
  kind,
  name,
  workspaceId,
}: BuildChatSourceDocumentProps) => {
  const { fileName, mimeType } = getFileMetadata({ fields });

  return {
    entityId,
    kind: kind ?? DEFAULT_SOURCE_DOCUMENT_KIND,
    mimeType,
    title: name ?? fileName ?? "Untitled",
    workspaceId: workspaceId ?? null,
  };
};
