import { Result } from "better-result";

import type { XmlDocumentPreview } from "@stll/api-contract/e-invoice";
import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import { hasZipMagic } from "@/api/lib/file-scan/zip";
import { scanCadesPayload } from "@/api/lib/files/cades-preview-worker";
import { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  type EInvoiceDocument,
  readEInvoiceFile,
  readEInvoiceXml,
} from "@/api/lib/files/e-invoice-document";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import type { P7mParseError } from "@/api/lib/files/p7m";
import { readXmlDocumentText } from "@/api/lib/files/xml-document-text";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

const notAnInvoice = () =>
  new DocumentPackageError({
    message: "The file is not a recognised structured invoice",
    reason: "invalid",
  });

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

/**
 * What an invoice file shows: its invoice, or, for XML that holds none, the
 * document's own text. A package or signed file that is not an invoice, and
 * a file that is not text at all, stays unreadable.
 */
export const extractEInvoicePreview = async ({
  fileBytes,
  mimeType,
  maxChars,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
  maxChars: number;
}): Promise<
  Result<
    XmlDocumentPreview,
    | DocumentPackageError
    | FileScanFailedError
    | FileScanRejectedError
    | P7mParseError
  >
> => {
  const read = await readStoredInvoice(fileBytes, mimeType);
  if (read.isOk() && read.value !== null) {
    return Result.ok({ type: "invoice", invoice: read.value.preview });
  }
  const isXmlFile =
    mimeType !== CADES_FILE_FORMAT.mimeType && !hasZipMagic(fileBytes);
  if (
    !isXmlFile ||
    (read.isErr() && read.error._tag !== "DocumentPackageError")
  ) {
    return read.isErr() ? Result.err(read.error) : Result.err(notAnInvoice());
  }
  return readXmlDocumentText(fileBytes, maxChars).map(
    ({ text, truncated }) => ({ type: "xml", text, truncated }),
  );
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
