import { Result, type UnhandledException } from "better-result";

import type { SignatureFileFormatKind } from "@stll/api-contract/legal-file-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import {
  parseCmsSignatureFile,
  type SignatureParseError,
} from "@/api/lib/files/signature-file";
import type { SignatureWorkerReply } from "@/api/lib/files/signature-preview-protocol";
import { parseXadesFile } from "@/api/lib/files/xades";
import {
  sanitizeFilename,
  sanitizeFilenamePreservingExtension,
} from "@/api/lib/sanitize-filename";

const SIGNATURE_SUFFIX = /(?:\.(?:p7s|sig|xades|xml))+$/iu;
const XML_MIME_TYPE = "application/xml";

const parseSignatureFile = (
  kind: SignatureFileFormatKind,
  bytes: Uint8Array,
) =>
  kind === "cadesDetached"
    ? parseCmsSignatureFile(bytes)
    : parseXadesFile(bytes);

const derivePayloadName = (outerName: string, extension: string | null) => {
  const stem = outerName.replace(SIGNATURE_SUFFIX, "").trim() || "document";
  const name =
    extension && !stem.toLowerCase().endsWith(`.${extension}`)
      ? `${stem}.${extension}`
      : stem;
  return sanitizeFilenamePreservingExtension(name);
};

type SignaturePreviewReadError =
  | SignatureParseError
  | FileScanFailedError
  | FileScanRejectedError
  | UnhandledException;

type ExtractSignaturePreviewOptions = {
  fileBytes: Uint8Array;
  kind: SignatureFileFormatKind;
  fileName: string;
  maxChars: number;
  readText: (
    file: ScannedFile,
    maxChars: number,
  ) => Promise<Result<string | null, UnhandledException>>;
};

/**
 * Reads a signature file in the worker. A document the signature carries is
 * scanned as an upload of its own before any reader sees it.
 */
export const extractSignaturePreview = async ({
  fileBytes,
  kind,
  fileName,
  maxChars,
  readText,
}: ExtractSignaturePreviewOptions): Promise<
  Result<
    { reply: SignatureWorkerReply; file: ScannedFile | null },
    SignaturePreviewReadError
  >
> => {
  const parsed = parseSignatureFile(kind, fileBytes);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { embedded, documentText, ...signature } = parsed.value;
  if (embedded === null) {
    return Result.ok({
      reply: {
        ...signature,
        document:
          documentText === null
            ? null
            : {
                fileName: sanitizeFilename(fileName || "document.xml"),
                mimeType: XML_MIME_TYPE,
                text: documentText.slice(0, maxChars),
              },
      },
      file: null,
    });
  }
  const { mimeType, extension } = detectEmbeddedPayload(embedded.bytes);
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  const scanned = await scanUpload({
    bytes: embedded.bytes,
    ownership: "transfer",
    declaredMimeType: mimeType,
    fileName: derivePayloadName(fileName, extension),
    // This worker runs outside the API's work pools, under its spawn timeout.
    admission: "subprocess",
  });
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  const file = scanned.value;
  const text = await readText(file, maxChars);
  if (text.isErr()) {
    return Result.err(text.error);
  }
  return Result.ok({
    reply: {
      ...signature,
      document: {
        fileName: sanitizeFilename(file.fileName),
        mimeType: file.mimeType,
        text: text.value ?? "",
      },
    },
    file,
  });
};
