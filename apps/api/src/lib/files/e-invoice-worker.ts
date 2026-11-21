import { Result } from "better-result";

import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import { scanCadesPayload } from "@/api/lib/files/cades-preview-worker";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  type EInvoiceDocument,
  readEInvoiceFile,
  readEInvoiceXml,
} from "@/api/lib/files/e-invoice-document";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import type { P7mParseError } from "@/api/lib/files/p7m";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

/**
 * The invoice a stored file holds. A signed `.p7m` is opened by the CAdES
 * reader first; its scanned payload is then read like any XML invoice.
 */
const readStoredInvoice = async (
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<
  Result<
    EInvoiceDocument | null,
    | DocumentPackageError
    | FileScanFailedError
    | FileScanRejectedError
    | P7mParseError
  >
> => {
  if (mimeType !== CADES_FILE_FORMAT.mimeType) {
    return await readEInvoiceFile(fileBytes);
  }
  const payload = await scanCadesPayload(fileBytes, "");
  if (payload.isErr()) {
    return Result.err(payload.error);
  }
  return readEInvoiceXml(new Uint8Array(payload.value.file.bytes));
};

export const extractEInvoicePreview = async ({
  fileBytes,
  mimeType,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
}) => {
  const read = await readStoredInvoice(fileBytes, mimeType);
  return read.map((document) => document?.preview ?? null);
};

/**
 * One attachment, scanned like an upload before it leaves the worker: the
 * invoice's declared name and type are claims, so its type is detected.
 */
export const extractEInvoiceAttachment = async ({
  fileBytes,
  mimeType,
  index,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
  index: number;
}) => {
  const read = await readStoredInvoice(fileBytes, mimeType);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const document: EInvoiceDocument | null = read.value;
  const attachment = document?.attachments[index];
  if (!document || !attachment) {
    return Result.ok(null);
  }
  const bytes = attachment.read();
  if (bytes.isErr()) {
    return Result.err(bytes.error);
  }
  const detected = detectEmbeddedPayload(bytes.value);
  const baseName = attachment.fileName.split("/").at(-1) ?? "";
  const fileName = sanitizeFilenamePreservingExtension(
    baseName.trim() ||
      `attachment${detected.extension ? `.${detected.extension}` : ""}`,
  );
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  const scanned = await scanUpload({
    bytes: bytes.value,
    declaredMimeType: detected.mimeType,
    fileName,
    // This worker runs outside the API's work pools, under its spawn timeout.
    admission: "subprocess",
  });
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  return Result.ok({
    fileName,
    mimeType: detected.mimeType,
    bytes: new Uint8Array(scanned.value.bytes),
  });
};
