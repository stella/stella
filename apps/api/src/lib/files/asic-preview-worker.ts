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
type AsicPreviewReadError =
  | AsicParseError
  | FileScanFailedError
  | FileScanRejectedError
  | UnhandledException;

type ExtractAsicPreviewOptions = {
  fileBytes: Uint8Array;
  expectedMimeType: string;
  maxChars: number;
  readText: (
    file: ScannedFile,
    maxChars: number,
  ) => Promise<Result<string | null, UnhandledException>>;
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

  const { zipBombGuard } = await import("@/api/lib/file-scan/pipeline");
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  const members: Preview["members"] = [];
  // Reserve room for every filename, heading and potential clipping notice.
  const layoutChars =
    asicDocumentText({
      members: parsed.value.members.map(({ fileName }) => ({
        fileName,
        status: "truncated",
        text: "",
      })),
    }).length + parsed.value.members.length;
  let remainingChars = Math.max(0, maxChars - layoutChars);
  for (const { fileName, bytes } of parsed.value.members) {
    // ZIP packages are recognized from their directory without inflating a
    // nested archive. The exact bytes still go through the usual upload scan.
    const officeMimeType =
      hasZipMagic(bytes) && (await zipBombGuard.scan(bytes)).length === 0
        ? readOfficeMimeType(bytes)
        : null;
    const declaredMimeType =
      officeMimeType ?? detectEmbeddedPayload(bytes).mimeType;
    const scanned = await scanUpload({
      bytes,
      ownership: "transfer",
      declaredMimeType,
      fileName: sanitizeFilenamePreservingExtension(fileName),
    });
    if (scanned.isErr()) {
      return Result.err(scanned.error);
    }
    if (declaredMimeType === OPAQUE_EMBEDDED_MIME_TYPE) {
      members.push({ fileName, status: "unavailable", text: "" });
      continue;
    }
    if (remainingChars === 0) {
      members.push({ fileName, status: "truncated", text: "" });
      continue;
    }
    const content = await readText(scanned.value, remainingChars + 1);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    const text = content.value;
    if (!text) {
      members.push({ fileName, status: "unavailable", text: "" });
      continue;
    }
    const status = text.length > remainingChars ? "truncated" : "readable";
    const visibleText = text.slice(0, remainingChars);
    members.push({ fileName, status, text: visibleText });
    remainingChars -= visibleText.length;
  }
  return Result.ok({ members });
};
