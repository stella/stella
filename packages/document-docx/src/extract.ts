import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  DOCX_EXTRACTION_ERROR_CODES,
  type DocxExtraction,
  type DocxExtractionErrorCode,
} from "./types";
import { decodeDocxExtraction } from "./native-codec";

export const DOCX_EXTRACTION_CONTRACT_VERSION = 1 as const;
export const DOCX_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const DOCX_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
export const DOCX_UNCOMPRESSED_MAX_BYTES = 128 * 1024 * 1024;
export const DOCX_XML_MAX_DEPTH = 256;

export class DocxExtractionError extends Error {
  readonly code: DocxExtractionErrorCode;

  constructor(code: DocxExtractionErrorCode, message: string) {
    super(message);
    this.name = "DocxExtractionError";
    this.code = code;
  }
}

const nativeExtractionErrorCode = (
  message: string,
): DocxExtractionErrorCode => {
  if (message.includes("unsafe entry path")) {
    return DOCX_EXTRACTION_ERROR_CODES.unsafeEntryPath;
  }
  if (message.includes("valid bounded DOCX ZIP archive")) {
    return DOCX_EXTRACTION_ERROR_CODES.invalidArchive;
  }
  if (message.includes("valid XML") || message.includes("valid UTF-8")) {
    return DOCX_EXTRACTION_ERROR_CODES.invalidXml;
  }
  if (
    message.includes(
      `DOCX archives must not exceed ${DOCX_ARCHIVE_MAX_BYTES} bytes`,
    )
  ) {
    return DOCX_EXTRACTION_ERROR_CODES.archiveLimitExceeded;
  }
  if (
    message.includes("must not exceed") ||
    message.includes("must not contain more than") ||
    message.includes("at most")
  ) {
    return DOCX_EXTRACTION_ERROR_CODES.uncompressedLimitExceeded;
  }
  return DOCX_EXTRACTION_ERROR_CODES.invalidPackage;
};

export const extractDocxText = (archive: Uint8Array): DocxExtraction => {
  const extract = loadNativeAnonymizeBinding().extractDocxTextJson;
  if (extract === undefined) {
    throw new DocxExtractionError(
      DOCX_EXTRACTION_ERROR_CODES.invalidPackage,
      "Native anonymize binding does not expose DOCX extraction",
    );
  }
  try {
    return decodeDocxExtraction(extract(archive));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DOCX extraction failed";
    throw new DocxExtractionError(nativeExtractionErrorCode(message), message);
  }
};
