import * as v from "valibot";

import type { FieldContent } from "@/api/db/schema-validators";

const mintedFileIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.brand("MintedFileId"),
);
const reusedFileIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.brand("ReusedFileId"),
);

export type MintedFileId = v.InferOutput<typeof mintedFileIdSchema>;

type ReusedFileId = v.InferOutput<typeof reusedFileIdSchema>;

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
  v.parse(mintedFileIdSchema, id);

const brandReusedFileId = (id: string): ReusedFileId =>
  v.parse(reusedFileIdSchema, id);
