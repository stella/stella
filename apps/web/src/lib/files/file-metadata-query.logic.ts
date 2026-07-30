export type StorageFetchPurpose = "display" | "download" | "native-display";

export type FileMetadataQueryKey = {
  workspaceId: string;
  fieldId: string;
  purpose?: StorageFetchPurpose;
};

export const fileMetadataQueryRoot = () => ["files", "metadata"];

export const fileMetadataQueryKey = (key: FileMetadataQueryKey) => [
  ...fileMetadataQueryRoot(),
  key.workspaceId,
  key.fieldId,
  key.purpose ?? "display",
];
