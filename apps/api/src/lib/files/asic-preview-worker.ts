import { Result, type UnhandledException } from "better-result";
import type { InferOutput } from "valibot";

import type { asicPreviewSchema } from "@stll/api-contract/asic";
import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { hasZipMagic, readZipIndex } from "@/api/lib/file-scan/zip";
import {
  AsicParseError,
  readAsicContainer,
} from "@/api/lib/files/asic-container";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import {
  detectEmbeddedPayload,
  OPAQUE_EMBEDDED_MIME_TYPE,
} from "@/api/lib/files/embedded-payload-format";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  DOCX_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

const OFFICE_PARTS = {
  "word/document.xml": DOCX_MIME_TYPE,
  "xl/workbook.xml": XLSX_MIME_TYPE,
  "ppt/presentation.xml": PPTX_MIME_TYPE,
};

const ODF_MIME_MARKERS = [ODT_MIME_TYPE, ODS_MIME_TYPE, ODP_MIME_TYPE];

const readOfficeMimeType = (bytes: Uint8Array): string | null => {
  const index = readZipIndex(bytes);
  if (index.type === "malformed") {
    return null;
  }
  const names = new Set(
    index.entries.map(({ name }) => name.toString("utf-8")),
  );
  if (names.has("[Content_Types].xml")) {
    const candidates = Object.entries(OFFICE_PARTS).filter(([part]) =>
      names.has(part),
    );
    return candidates.length === 1 ? (candidates.at(0)?.[1] ?? null) : null;
  }

  if (names.has("content.xml")) {
    const mimeEntry = index.entries.at(0);
    if (
      mimeEntry?.name.toString("utf-8") === "mimetype" &&
      mimeEntry.method === 0
    ) {
      return (
        ODF_MIME_MARKERS.find(
          (mimeType) =>
            mimeEntry.data.byteLength === mimeType.length &&
            Buffer.from(mimeEntry.data).equals(Buffer.from(mimeType)),
        ) ?? null
      );
    }
  }
  return null;
};

type Preview = InferOutput<typeof asicPreviewSchema>;
type MemberTextReadError =
  FileScanFailedError | FileScanRejectedError | UnhandledException;
type AsicPreviewReadError = AsicParseError | MemberTextReadError;

export type ReadMemberText = (
  file: ScannedFile,
  maxChars: number,
) => Promise<Result<string | null, UnhandledException>>;

/** A document inside a container. An opaque one is listed but never read. */
export type ContainerMember = {
  fileName: string;
  bytes: Uint8Array;
  opaque?: boolean;
};

export type ContainerMemberText = Preview["members"][number] & {
  mimeType: string;
};

/** The media type a member is scanned and read as, from its own bytes. */
export const containerMemberMimeType = async (bytes: Uint8Array) => {
  const { zipBombGuard } = await import("@/api/lib/file-scan/pipeline");
  // ZIP packages are recognized from their directory without inflating a
  // nested archive. The exact bytes still go through the usual upload scan.
  const officeMimeType =
    hasZipMagic(bytes) && (await zipBombGuard.scan(bytes)).length === 0
      ? readOfficeMimeType(bytes)
      : null;
  return officeMimeType ?? detectEmbeddedPayload(bytes).mimeType;
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
        status: "unavailable",
        text: "",
      });
      continue;
    }
    const mimeType = await containerMemberMimeType(member.bytes);
    const scanned = await scanContainerMember(member, mimeType);
    if (scanned.isErr()) {
      return Result.err(scanned.error);
    }
    const unread = { fileName: member.fileName, mimeType, text: "" };
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
    const text = content.value;
    if (!text) {
      texts.push({ ...unread, status: "unavailable" });
      continue;
    }
    const status = text.length > remainingChars ? "truncated" : "readable";
    const visibleText = text.slice(0, remainingChars);
    texts.push({ ...unread, status, text: visibleText });
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
    members: members.value.map(({ fileName, status, text }) => ({
      fileName,
      status,
      text,
    })),
  });
};
