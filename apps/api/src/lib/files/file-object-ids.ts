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

/**
 * The object id a queued derivative job carries, allocated once by the
 * producer so every attempt of that job writes the same storage key. Allocating
 * per attempt instead is what this replaces: an attempt that dies after its
 * write leaves an object no row will ever name.
 *
 * The fallback covers jobs enqueued before the id moved into the payload, which
 * carry none; it can go once no such job remains queued.
 */
export const resolveQueuedFileObject = (
  fileId: string | undefined,
): MintedFileId =>
  fileId === undefined ? allocateFileObject() : brandMintedFileId(fileId);

type DeriveFileObjectOptions = {
  namespace: string;
  slot: string;
};

/**
 * Derive a retry-stable RFC 9562 UUIDv8 for a file object.
 *
 * A finalize retry must target the same key after a process dies between the
 * S3 write and the database commit. The pending upload ID is the durable
 * namespace; a purpose-owned slot distinguishes each object within it.
 */
export const deriveFileObject = ({
  namespace,
  slot,
}: DeriveFileObjectOptions): MintedFileId => {
  const hex = new Bun.CryptoHasher("sha256")
    .update(`${namespace}\0${slot}`)
    .digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return brandMintedFileId(uuid);
};

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
