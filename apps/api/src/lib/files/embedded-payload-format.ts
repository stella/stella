import { isUtf8 } from "node:buffer";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { PDF_MIME_TYPE, RTF_MIME_TYPE } from "@/api/mime-types";

export const OPAQUE_EMBEDDED_MIME_TYPE = "application/octet-stream";

const BINARY_PAYLOAD = {
  mimeType: OPAQUE_EMBEDDED_MIME_TYPE,
  extension: null,
};
const TEXT_PAYLOAD = { mimeType: "text/plain", extension: "txt" };
export const XML_EMBEDDED_MIME_TYPE = "application/xml";
const XML_PAYLOAD = { mimeType: XML_EMBEDDED_MIME_TYPE, extension: "xml" };
// Text that opens with an XML declaration, comment, processing instruction
// or element, after any BOM.
const XML_START = /^\uFEFF?\s*<[?!A-Za-z_]/u;
const isTextByte = (byte: number) =>
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0d ||
  (byte >= 0x20 && byte !== 0x7f);

export const detectEmbeddedPayload = (bytes: Uint8Array) => {
  if (declaredMimeMatchesMagic(PDF_MIME_TYPE, bytes)) {
    return { mimeType: PDF_MIME_TYPE, extension: "pdf" };
  }

  if (new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("{\\rtf")) {
    return { mimeType: RTF_MIME_TYPE, extension: "rtf" };
  }

  if (bytes.length > 0 && isUtf8(bytes) && bytes.every(isTextByte)) {
    return XML_START.test(new TextDecoder().decode(bytes.subarray(0, 256)))
      ? XML_PAYLOAD
      : TEXT_PAYLOAD;
  }

  return BINARY_PAYLOAD;
};
