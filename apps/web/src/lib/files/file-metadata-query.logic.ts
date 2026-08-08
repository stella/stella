export type StorageFetchPurpose = "display" | "download" | "native-display";

export type FileMetadataQueryKey = {
  workspaceId: string;
  fieldId: string;
  purpose?: StorageFetchPurpose;
};

export const filesQueryRoot = () => ["files"];

export const fileContentByFieldQueryRoot = ({
  workspaceId,
  fieldId,
}: Pick<FileMetadataQueryKey, "workspaceId" | "fieldId">) => [
  ...filesQueryRoot(),
  workspaceId,
  fieldId,
];

export const fileContentQueryKey = (key: FileMetadataQueryKey) => [
  ...fileContentByFieldQueryRoot(key),
  key.purpose ?? "display",
];

export const fileMetadataQueryRoot = () => [...filesQueryRoot(), "metadata"];

export const fileMetadataByFieldQueryRoot = ({
  workspaceId,
  fieldId,
}: Pick<FileMetadataQueryKey, "workspaceId" | "fieldId">) => [
  ...fileMetadataQueryRoot(),
  workspaceId,
  fieldId,
];

export const fileMetadataQueryKey = (key: FileMetadataQueryKey) => [
  ...fileMetadataByFieldQueryRoot(key),
  key.purpose ?? "display",
];

export const documentPropertiesQueryKey = (key: FileMetadataQueryKey) => [
  ...filesQueryRoot(),
  "document-properties",
  key.workspaceId,
  key.fieldId,
];
