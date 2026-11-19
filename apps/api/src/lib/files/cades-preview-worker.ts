import { Result } from "better-result";
import { isUtf8 } from "node:buffer";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { parseP7m } from "@/api/lib/files/p7m";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { PDF_MIME_TYPE, RTF_MIME_TYPE } from "@/api/mime-types";

const BINARY_PAYLOAD = {
  mimeType: "application/octet-stream",
  extension: null,
};
const TEXT_PAYLOAD = { mimeType: "text/plain", extension: "txt" };
const isTextByte = (byte: number) =>
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0d ||
  (byte >= 0x20 && byte !== 0x7f);

const detectPayload = (bytes: Uint8Array) => {
  if (declaredMimeMatchesMagic(PDF_MIME_TYPE, bytes)) {
    return { mimeType: PDF_MIME_TYPE, extension: "pdf" };
  }

  if (new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("{\\rtf")) {
    return { mimeType: RTF_MIME_TYPE, extension: "rtf" };
  }

  if (bytes.length > 0 && isUtf8(bytes) && bytes.every(isTextByte)) {
    return TEXT_PAYLOAD;
  }

  return BINARY_PAYLOAD;
};

const derivePayloadName = (outerName: string, extension: string | null) => {
  const stem = outerName.replace(/(?:\.p7m)+$/iu, "").trim() || "attachment";
  const name =
    extension && !stem.toLowerCase().endsWith(`.${extension}`)
      ? `${stem}.${extension}`
      : stem;
  return sanitizeFilenamePreservingExtension(name);
};

/** The CMS parser is isolated in the worker. Its payload needs its own scan. */
export const scanCadesPayload = async (
  fileBytes: Uint8Array,
  outerName: string,
) => {
  const parsed = parseP7m(fileBytes);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { bytes, layers } = parsed.value;
  const { mimeType, extension } = detectPayload(bytes);
  const fileName = derivePayloadName(outerName, extension);
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  const scanned = await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType: mimeType,
    fileName,
  });
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  return Result.ok({
    file: scanned.value,
    layers: layers.map(({ signers }) => ({
      signers: signers.map(({ name }) => ({ name })),
    })),
  });
};
