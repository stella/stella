import type {
  PdfRasterDetection,
  PdfRasterRewriteCertificate,
} from "@stll/anonymize-pdf";

import type { DocumentOcrPage } from "@/api/lib/document-processing-contract";
import { parseOcrPage } from "@/api/lib/document-processing-ocr-result";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const LENGTH_PREFIX_BYTES = 4;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type PdfAnonymizationObservedPage = {
  detections: readonly PdfRasterDetection[];
  ocr: DocumentOcrPage;
};

export type PdfAnonymizationWorkerRequest = {
  pages: readonly PdfAnonymizationObservedPage[];
};

export type PdfAnonymizationWorkerResponse = {
  certificate: PdfRasterRewriteCertificate;
  document: Uint8Array;
};

const encodeFrame = (header: unknown, payload: Uint8Array): Uint8Array => {
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  if (encodedHeader.byteLength > MAX_HEADER_BYTES) {
    throw new RangeError("PDF anonymization worker header exceeded its limit");
  }
  const output = new Uint8Array(
    LENGTH_PREFIX_BYTES + encodedHeader.byteLength + payload.byteLength,
  );
  new DataView(output.buffer).setUint32(0, encodedHeader.byteLength, false);
  output.set(encodedHeader, LENGTH_PREFIX_BYTES);
  output.set(payload, LENGTH_PREFIX_BYTES + encodedHeader.byteLength);
  return output;
};

const decodeFrame = (
  input: Uint8Array,
): { header: unknown; payload: Uint8Array } => {
  if (input.byteLength < LENGTH_PREFIX_BYTES) {
    throw new TypeError("PDF anonymization worker frame is truncated");
  }
  const headerLength = new DataView(
    input.buffer,
    input.byteOffset,
    LENGTH_PREFIX_BYTES,
  ).getUint32(0, false);
  if (
    headerLength > MAX_HEADER_BYTES ||
    headerLength > input.byteLength - LENGTH_PREFIX_BYTES
  ) {
    throw new TypeError("PDF anonymization worker frame header is invalid");
  }
  const headerBytes = input.subarray(
    LENGTH_PREFIX_BYTES,
    LENGTH_PREFIX_BYTES + headerLength,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
  const header: unknown = JSON.parse(text);
  return {
    header,
    payload: input.subarray(LENGTH_PREFIX_BYTES + headerLength),
  };
};

const parseDetections = (
  value: unknown,
): readonly PdfRasterDetection[] | null => {
  if (!isUnknownArray(value)) {
    return null;
  }
  const detections: PdfRasterDetection[] = [];
  let previousEnd = 0;
  for (const detection of value) {
    if (
      !isRecord(detection) ||
      Object.keys(detection).length !== 2 ||
      typeof detection["start"] !== "number" ||
      typeof detection["end"] !== "number" ||
      !Number.isSafeInteger(detection["start"]) ||
      !Number.isSafeInteger(detection["end"]) ||
      detection["start"] < previousEnd ||
      detection["end"] <= detection["start"]
    ) {
      return null;
    }
    detections.push({ start: detection["start"], end: detection["end"] });
    previousEnd = detection["end"];
  }
  return detections;
};

export const encodePdfAnonymizationWorkerRequest = ({
  document,
  pages,
}: PdfAnonymizationWorkerRequest & { document: Uint8Array }): Uint8Array =>
  encodeFrame({ pages }, document);

export const decodePdfAnonymizationWorkerRequest = (
  input: Uint8Array,
): PdfAnonymizationWorkerRequest & { document: Uint8Array } => {
  const { header, payload } = decodeFrame(input);
  if (
    !isRecord(header) ||
    Object.keys(header).length !== 1 ||
    !isUnknownArray(header["pages"])
  ) {
    throw new TypeError("PDF anonymization worker request is invalid");
  }
  const pages: PdfAnonymizationObservedPage[] = [];
  for (const value of header["pages"]) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      !("ocr" in value) ||
      !("detections" in value)
    ) {
      throw new TypeError("PDF anonymization worker page is invalid");
    }
    const ocr = parseOcrPage(value["ocr"]);
    const detections = parseDetections(value["detections"]);
    if (ocr === null || detections === null) {
      throw new TypeError("PDF anonymization worker page is invalid");
    }
    pages.push({ detections, ocr });
  }
  return { document: payload, pages };
};

const PROVIDER_FIELDS = {
  providerId: true,
  rendererName: true,
  rendererVersion: true,
  ocrName: true,
  ocrVersion: true,
  ocrLanguage: true,
} as const satisfies Record<
  keyof PdfRasterRewriteCertificate["provider"],
  true
>;

const CERTIFICATE_FIELDS = {
  contractVersion: true,
  pageCount: true,
  sourceSha256: true,
  outputSha256: true,
  provider: true,
  detectionCount: true,
  mappedRegionCount: true,
  structurePixelRewriteVerified: true,
  providerAssertedCoverage: true,
  piiCleanGuaranteed: true,
  limitation: true,
} as const satisfies Record<keyof PdfRasterRewriteCertificate, true>;

const isProvider = (
  value: unknown,
): value is PdfRasterRewriteCertificate["provider"] =>
  isRecord(value) &&
  Object.keys(value).length === Object.keys(PROVIDER_FIELDS).length &&
  typeof value["providerId"] === "string" &&
  typeof value["rendererName"] === "string" &&
  typeof value["rendererVersion"] === "string" &&
  typeof value["ocrName"] === "string" &&
  typeof value["ocrVersion"] === "string" &&
  typeof value["ocrLanguage"] === "string";

const isCertificate = (value: unknown): value is PdfRasterRewriteCertificate =>
  isRecord(value) &&
  Object.keys(value).length === Object.keys(CERTIFICATE_FIELDS).length &&
  value["contractVersion"] === 1 &&
  typeof value["pageCount"] === "number" &&
  Number.isSafeInteger(value["pageCount"]) &&
  value["pageCount"] > 0 &&
  typeof value["sourceSha256"] === "string" &&
  SHA256_PATTERN.test(value["sourceSha256"]) &&
  typeof value["outputSha256"] === "string" &&
  SHA256_PATTERN.test(value["outputSha256"]) &&
  isProvider(value["provider"]) &&
  typeof value["detectionCount"] === "number" &&
  Number.isSafeInteger(value["detectionCount"]) &&
  value["detectionCount"] >= 0 &&
  typeof value["mappedRegionCount"] === "number" &&
  Number.isSafeInteger(value["mappedRegionCount"]) &&
  value["mappedRegionCount"] >= 0 &&
  value["structurePixelRewriteVerified"] === true &&
  value["providerAssertedCoverage"] ===
    "complete-rendering-and-ocr-observation" &&
  value["piiCleanGuaranteed"] === false &&
  typeof value["limitation"] === "string";

export const encodePdfAnonymizationWorkerResponse = ({
  certificate,
  document,
}: PdfAnonymizationWorkerResponse): Uint8Array =>
  encodeFrame({ certificate }, document);

export const decodePdfAnonymizationWorkerResponse = (
  input: Uint8Array,
): PdfAnonymizationWorkerResponse => {
  const { header, payload } = decodeFrame(input);
  if (
    !isRecord(header) ||
    Object.keys(header).length !== 1 ||
    !isCertificate(header["certificate"])
  ) {
    throw new TypeError("PDF anonymization worker response is invalid");
  }
  return { certificate: header["certificate"], document: payload };
};
