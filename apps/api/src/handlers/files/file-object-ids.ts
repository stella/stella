import type { FieldContent } from "@/api/db/schema-validators";

declare const __fileObjectId: unique symbol;

export type MintedFileId = string & {
  readonly [__fileObjectId]: "MintedFileId";
};

type ReusedFileId = string & {
  readonly [__fileObjectId]: "ReusedFileId";
};

type WritableFileId = MintedFileId | ReusedFileId;

type FileFieldContent = Extract<FieldContent, { type: "file" }>;
type MintedFileFieldContent = Omit<
  FileFieldContent,
  "id" | "pdfFileId" | "thumbnailFileId"
> & {
  id: MintedFileId;
  pdfFileId: MintedFileId | null;
  thumbnailFileId?: MintedFileId | null;
};

export type WritableFileFieldContent = Omit<
  FileFieldContent,
  "id" | "pdfFileId" | "thumbnailFileId"
> & {
  id: WritableFileId;
  pdfFileId: WritableFileId | null;
  thumbnailFileId?: WritableFileId | null;
};

export type WritableFieldContent =
  | Exclude<FieldContent, { type: "file" }>
  | WritableFileFieldContent;

export const allocateFileObject = (): MintedFileId =>
  brandMintedFileId(Bun.randomUUIDv7());

export const fileContentWithMintedObject = (
  content: MintedFileFieldContent,
): WritableFileFieldContent => {
  const { thumbnailFileId, ...contentWithoutThumbnail } = content;

  if (thumbnailFileId === undefined) {
    return contentWithoutThumbnail;
  }

  return { ...contentWithoutThumbnail, thumbnailFileId };
};

export const reuseFileObjectWithinEntity = (
  content: FileFieldContent,
): WritableFileFieldContent => {
  const { thumbnailFileId, ...contentWithoutThumbnail } = content;
  const reusedContent = {
    ...contentWithoutThumbnail,
    id: brandReusedFileId(content.id),
    pdfFileId: content.pdfFileId ? brandReusedFileId(content.pdfFileId) : null,
  };

  if (thumbnailFileId === undefined) {
    return reusedContent;
  }

  return {
    ...reusedContent,
    thumbnailFileId: thumbnailFileId
      ? brandReusedFileId(thumbnailFileId)
      : null,
  };
};

const brandMintedFileId = (id: string): MintedFileId =>
  // SAFETY: allocateFileObject is the only public minting boundary for new field-backed file object IDs.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  id as MintedFileId;

const brandReusedFileId = (id: string): ReusedFileId =>
  // SAFETY: reuseFileObjectWithinEntity is the explicit escape hatch for same-entity version history.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  id as ReusedFileId;
