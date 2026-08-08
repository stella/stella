export type StorageFetchPurpose = "display" | "download" | "native-display";

export type FileMetadataQueryKey = {
  workspaceId: string;
  fieldId: string;
  purpose?: StorageFetchPurpose;
};

export const filesQueryRoot = () => ["files"];

export const fileContentQueryKey = (key: FileMetadataQueryKey) => [
  ...filesQueryRoot(),
  key.workspaceId,
  key.fieldId,
  key.purpose ?? "display",
];

export const fileMetadataQueryRoot = () => [...filesQueryRoot(), "metadata"];

export const fileMetadataQueryKey = (key: FileMetadataQueryKey) => [
  ...fileMetadataQueryRoot(),
  key.workspaceId,
  key.fieldId,
  key.purpose ?? "display",
];

export const documentPropertiesQueryKey = (key: FileMetadataQueryKey) => [
  ...filesQueryRoot(),
  "document-properties",
  key.workspaceId,
  key.fieldId,
];
