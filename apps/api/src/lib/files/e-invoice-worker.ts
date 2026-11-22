import { Result } from "better-result";

import type { EInvoicePreview } from "@stll/api-contract/e-invoice";
import { FILE_PART_KINDS, filePartId } from "@stll/api-contract/file-parts";
import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import { scanCadesPayload } from "@/api/lib/files/cades-preview-worker";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  type EInvoiceDocument,
  type InvoiceAttachment,
  readEInvoiceFile,
  readEInvoiceXml,
} from "@/api/lib/files/e-invoice-document";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import type { P7mParseError } from "@/api/lib/files/p7m";
import { partMediaType } from "@/api/lib/files/part-media-type";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

/**
 * The invoice a stored file holds. A signed `.p7m` is opened by the CAdES
 * reader first; its scanned payload is then read like any XML invoice.
 */
export const readStoredInvoice = async (
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
 * An attachment as a part of the file: its own base name (the invoice's
 * stated name is a claim and may carry a path), else `attachment` with the
 * extension its bytes show, and its bytes.
 */
export const invoiceAttachmentPart = (attachment: InvoiceAttachment) =>
  attachment.read().map((bytes) => {
    const baseName = attachment.fileName.split("/").at(-1)?.trim() ?? "";
    const { extension } = detectEmbeddedPayload(bytes);
    return {
      fileName: sanitizeFilenamePreservingExtension(
        baseName || `attachment${extension ? `.${extension}` : ""}`,
      ),
      bytes,
    };
  });

/** A read invoice's preview, its attachments listed as parts of the file. */
export const listEInvoiceParts = async ({
  preview,
  attachments,
}: EInvoiceDocument): Promise<
  Result<EInvoicePreview, DocumentPackageError>
> => {
  const listed: EInvoicePreview["attachments"] = [];
  for (const [index, attachment] of attachments.entries()) {
    const read = invoiceAttachmentPart(attachment);
    if (read.isErr()) {
      return Result.err(read.error);
    }
    const { fileName, bytes } = read.value;
    listed.push({
      part: filePartId({ kind: FILE_PART_KINDS.attachment, index }),
      fileName,
      description: attachment.description,
      // The invoice's stated type is a claim; the bytes and name decide.
      mediaType: await partMediaType({ bytes, stated: null, fileName }),
      sizeBytes: bytes.byteLength,
    });
  }
  return Result.ok({ ...preview, attachments: listed });
};

export const extractEInvoicePreview = async ({
  fileBytes,
  mimeType,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
}) => {
  const read = await readStoredInvoice(fileBytes, mimeType);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return read.value === null
    ? Result.ok(null)
    : await listEInvoiceParts(read.value);
};
