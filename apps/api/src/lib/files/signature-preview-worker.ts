import { Result, type UnhandledException } from "better-result";

import type { SignatureFileFormatKind } from "@stll/api-contract/legal-file-formats";
import type { PreviewText } from "@stll/api-contract/preview-text";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import { containerMemberMimeType } from "@/api/lib/files/part-media-type";
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
import {
  DOCX_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

const SIGNATURE_SUFFIX = /(?:\.(?:p7s|sig|xades|xml))+$/iu;
const XML_MIME_TYPE = "application/xml";

// An Office or OpenDocument package is a ZIP: its type comes from its parts.
const PACKAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [DOCX_MIME_TYPE, "docx"],
  [XLSX_MIME_TYPE, "xlsx"],
  [PPTX_MIME_TYPE, "pptx"],
  [ODT_MIME_TYPE, "odt"],
  [ODS_MIME_TYPE, "ods"],
  [ODP_MIME_TYPE, "odp"],
]);

/** The carried document's type and extension, from its own bytes. */
const embeddedPayloadType = async (bytes: Uint8Array) => {
  const mimeType = await containerMemberMimeType(bytes);
  const extension =
    PACKAGE_EXTENSIONS.get(mimeType) ?? detectEmbeddedPayload(bytes).extension;
  return { mimeType, extension };
};

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
  ) => Promise<Result<PreviewText | null, UnhandledException>>;
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
  Result<{ reply: SignatureWorkerReply }, SignaturePreviewReadError>
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
    });
  }
  const { mimeType, extension } = await embeddedPayloadType(embedded.bytes);
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
        text: text.value?.text ?? "",
      },
    },
  });
};
