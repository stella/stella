import { Result, type UnhandledException } from "better-result";
import type { InferOutput } from "valibot";

import type { asicPreviewSchema } from "@stll/api-contract/asic";
import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { FILE_PART_KINDS, filePartId } from "@stll/api-contract/file-parts";
import type { PreviewText } from "@stll/api-contract/preview-text";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  AsicParseError,
  readAsicContainer,
} from "@/api/lib/files/asic-container";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import { OPAQUE_EMBEDDED_MIME_TYPE } from "@/api/lib/files/embedded-payload-format";
import {
  containerMemberMimeType,
  partMediaTypeOf,
} from "@/api/lib/files/part-media-type";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

type Preview = InferOutput<typeof asicPreviewSchema>;
type MemberTextReadError =
  FileScanFailedError | FileScanRejectedError | UnhandledException;
type AsicPreviewReadError = AsicParseError | MemberTextReadError;

export type ReadMemberText = (
  file: ScannedFile,
  maxChars: number,
) => Promise<Result<PreviewText | null, UnhandledException>>;

/** A document inside a container. An opaque one is listed but never read. */
export type ContainerMember = {
  fileName: string;
  bytes: Uint8Array;
  opaque?: boolean;
};

/**
 * A member's reading: its text, the type it was read as (from its bytes
 * alone), and the type and size it is listed and delivered with as a part.
 */
export type ContainerMemberText = Pick<
  Preview["members"][number],
  "fileName" | "status" | "text" | "textFormat" | "mediaType" | "sizeBytes"
> & {
  mimeType: string;
};

/** Scans one member exactly as an upload of its bytes would be scanned. */
export const scanContainerMember = async (
  { fileName, bytes }: ContainerMember,
  declaredMimeType: string,
) => {
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  return await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType,
    fileName: sanitizeFilenamePreservingExtension(fileName),
    // This worker runs outside the API's work pools, under its spawn timeout.
    admission: "subprocess",
  });
};

/**
 * Scans each member like an upload, then reads the text of recognized leaf
 * documents within one shared character budget, in container order.
 */
export const readContainerMemberTexts = async ({
  members,
  maxChars,
  readText,
}: {
  members: readonly ContainerMember[];
  maxChars: number;
  readText: ReadMemberText;
}): Promise<Result<ContainerMemberText[], MemberTextReadError>> => {
  const texts: ContainerMemberText[] = [];
  let remainingChars = maxChars;
  for (const member of members) {
    // A member the container marks opaque is never read or delivered.
    if (member.opaque === true) {
      texts.push({
        fileName: member.fileName,
        mimeType: OPAQUE_EMBEDDED_MIME_TYPE,
        mediaType: OPAQUE_EMBEDDED_MIME_TYPE,
        sizeBytes: member.bytes.byteLength,
        status: "unavailable",
        text: "",
        textFormat: "plain",
      });
      continue;
    }
    const mimeType = await containerMemberMimeType(member.bytes);
    // The scan takes ownership of the bytes; type and size are read first.
    const mediaType = partMediaTypeOf({
      bytes: member.bytes,
      detected: mimeType,
      stated: null,
      charset: null,
      fileName: member.fileName,
    });
    const sizeBytes = member.bytes.byteLength;
    const scanned = await scanContainerMember(member, mimeType);
    if (scanned.isErr()) {
      return Result.err(scanned.error);
    }
    const unread = {
      fileName: member.fileName,
      mimeType,
      mediaType,
      sizeBytes,
      text: "",
      textFormat: "plain",
    } as const;
    if (mimeType === OPAQUE_EMBEDDED_MIME_TYPE) {
      texts.push({ ...unread, status: "unavailable" });
      continue;
    }
    if (remainingChars === 0) {
      texts.push({ ...unread, status: "truncated" });
      continue;
    }
    const content = await readText(scanned.value, remainingChars + 1);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    if (content.value === null) {
      texts.push({ ...unread, status: "unavailable" });
      continue;
    }
    const { text, format: textFormat } = content.value;
    const status = text.length > remainingChars ? "truncated" : "readable";
    const visibleText = text.slice(0, remainingChars);
    texts.push({ ...unread, status, text: visibleText, textFormat });
    remainingChars -= visibleText.length;
  }
  return Result.ok(texts);
};

type ExtractAsicPreviewOptions = {
  fileBytes: Uint8Array;
  expectedMimeType: string;
  maxChars: number;
  readText: ReadMemberText;
};

export const extractAsicPreview = async ({
  fileBytes,
  expectedMimeType,
  maxChars,
  readText,
}: ExtractAsicPreviewOptions): Promise<
  Result<Preview, AsicPreviewReadError>
> => {
  const format = ASIC_FILE_FORMATS.find(
    ({ mimeType }) => mimeType === expectedMimeType,
  );
  if (!format) {
    return Result.err(
      new AsicParseError({
        message: "Unknown ASiC container type",
        reason: "invalid",
      }),
    );
  }
  const parsed = await readAsicContainer(fileBytes, format.mimeType);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }

  // Reserve room for every filename, heading and potential clipping notice.
  const layoutChars =
    asicDocumentText({
      members: parsed.value.members.map(({ fileName }) => ({
        fileName,
        status: "truncated",
        text: "",
        textFormat: "plain",
      })),
    }).length + parsed.value.members.length;
  const members = await readContainerMemberTexts({
    members: parsed.value.members,
    maxChars: Math.max(0, maxChars - layoutChars),
    readText,
  });
  if (members.isErr()) {
    return Result.err(members.error);
  }
  return Result.ok({
    members: members.value.map(
      (
        { fileName, mediaType, sizeBytes, status, text, textFormat },
        index,
      ) => ({
        part: filePartId({ kind: FILE_PART_KINDS.member, index }),
        // Listed by the name the part link delivers it under.
        fileName: sanitizeFilenamePreservingExtension(fileName),
        mediaType,
        sizeBytes,
        status,
        text,
        textFormat,
      }),
    ),
  });
};
