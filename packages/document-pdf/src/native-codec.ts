import type {
  PdfGlyphObservation,
  PdfInspection,
  PdfInspectionGap,
  PdfPageInspection,
  PdfPageObservation,
  PdfRasterProvider,
  PdfRasterRewriteCertificate,
  PdfRect,
  PdfRiskInventory,
} from "./types";

type RequiredFields<T> = { [Key in keyof T]-?: true };

const RECT_FIELDS = {
  left: true,
  bottom: true,
  right: true,
  top: true,
} as const satisfies RequiredFields<PdfRect>;

const GLYPH_FIELDS = {
  start: true,
  end: true,
  bounds: true,
  source: true,
} as const satisfies RequiredFields<PdfGlyphObservation>;

const OBSERVATION_FIELDS = {
  pageIndex: true,
  widthPoints: true,
  heightPoints: true,
  text: true,
  glyphs: true,
  rendered: true,
  textLayer: true,
  ocr: true,
  imageCount: true,
} as const satisfies RequiredFields<PdfPageObservation>;

const PAGE_FIELDS = {
  pageIndex: true,
  widthPoints: true,
  heightPoints: true,
  annotationCount: true,
  observation: true,
} as const satisfies RequiredFields<PdfPageInspection>;

const RISK_FIELDS = {
  acroFormFieldCount: true,
  annotationCount: true,
  documentInfoEntryCount: true,
  embeddedFileCount: true,
  externalActionCount: true,
  formXObjectCount: true,
  imageObjectCount: true,
  incrementalRevisionCount: true,
  javascriptActionCount: true,
  metadataStreamCount: true,
  optionalContentGroupCount: true,
  signatureCount: true,
  trailingNonWhitespaceByteCount: true,
  unsupportedActionCount: true,
  xfaEntryCount: true,
} as const satisfies RequiredFields<PdfRiskInventory>;

const INSPECTION_FIELDS = {
  contractVersion: true,
  pdfVersion: true,
  byteLength: true,
  objectCount: true,
  pageCount: true,
  encrypted: true,
  pages: true,
  risks: true,
  coverage: true,
} as const satisfies RequiredFields<PdfInspection>;

const PROVIDER_FIELDS = {
  providerId: true,
  rendererName: true,
  rendererVersion: true,
  ocrName: true,
  ocrVersion: true,
  ocrLanguage: true,
} as const satisfies RequiredFields<PdfRasterProvider>;

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
} as const satisfies RequiredFields<PdfRasterRewriteCertificate>;

const COVERAGE_FIELDS = {
  status: true,
  gaps: true,
} as const satisfies RequiredFields<PdfInspection["coverage"]>;

const INSPECTION_GAPS = {
  "encrypted-document": true,
  "page-content-not-observed": true,
  "page-not-rendered": true,
  "partial-text-layer": true,
  "retained-document-bytes": true,
  "unobserved-visual-content": true,
} as const satisfies Record<PdfInspectionGap, true>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactFields = (
  value: Record<string, unknown>,
  fields: Record<string, true>,
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === Object.keys(fields).length &&
    keys.every((key) => Object.hasOwn(fields, key))
  );
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRect = (value: unknown): value is PdfRect =>
  isRecord(value) &&
  hasExactFields(value, RECT_FIELDS) &&
  isFiniteNumber(value["left"]) &&
  isFiniteNumber(value["bottom"]) &&
  isFiniteNumber(value["right"]) &&
  isFiniteNumber(value["top"]);

const isGlyph = (value: unknown): value is PdfGlyphObservation =>
  isRecord(value) &&
  hasExactFields(value, GLYPH_FIELDS) &&
  isNonNegativeInteger(value["start"]) &&
  isNonNegativeInteger(value["end"]) &&
  value["end"] >= value["start"] &&
  isRect(value["bounds"]) &&
  (value["source"] === "embedded-text" || value["source"] === "ocr");

const isObservation = (value: unknown): value is PdfPageObservation =>
  isRecord(value) &&
  hasExactFields(value, OBSERVATION_FIELDS) &&
  isNonNegativeInteger(value["pageIndex"]) &&
  isFiniteNumber(value["widthPoints"]) &&
  value["widthPoints"] > 0 &&
  isFiniteNumber(value["heightPoints"]) &&
  value["heightPoints"] > 0 &&
  typeof value["text"] === "string" &&
  Array.isArray(value["glyphs"]) &&
  value["glyphs"].every(isGlyph) &&
  typeof value["rendered"] === "boolean" &&
  (value["textLayer"] === "absent" ||
    value["textLayer"] === "partial" ||
    value["textLayer"] === "complete") &&
  (value["ocr"] === "not-run" ||
    value["ocr"] === "partial" ||
    value["ocr"] === "complete") &&
  isNonNegativeInteger(value["imageCount"]);

const isPage = (value: unknown): value is PdfPageInspection =>
  isRecord(value) &&
  hasExactFields(value, PAGE_FIELDS) &&
  isNonNegativeInteger(value["pageIndex"]) &&
  isFiniteNumber(value["widthPoints"]) &&
  value["widthPoints"] > 0 &&
  isFiniteNumber(value["heightPoints"]) &&
  value["heightPoints"] > 0 &&
  isNonNegativeInteger(value["annotationCount"]) &&
  (value["observation"] === null || isObservation(value["observation"]));

const isRiskInventory = (value: unknown): value is PdfRiskInventory =>
  isRecord(value) &&
  hasExactFields(value, RISK_FIELDS) &&
  Object.keys(RISK_FIELDS).every((field) => isNonNegativeInteger(value[field]));

const isInspectionGap = (value: unknown): value is PdfInspectionGap =>
  typeof value === "string" && Object.hasOwn(INSPECTION_GAPS, value);

const isInspection = (value: unknown): value is PdfInspection =>
  isRecord(value) &&
  hasExactFields(value, INSPECTION_FIELDS) &&
  value["contractVersion"] === 1 &&
  typeof value["pdfVersion"] === "string" &&
  isNonNegativeInteger(value["byteLength"]) &&
  isNonNegativeInteger(value["objectCount"]) &&
  isNonNegativeInteger(value["pageCount"]) &&
  typeof value["encrypted"] === "boolean" &&
  Array.isArray(value["pages"]) &&
  value["pages"].length === value["pageCount"] &&
  value["pages"].every(isPage) &&
  value["pages"].every(({ pageIndex }, index) => pageIndex === index) &&
  isRiskInventory(value["risks"]) &&
  isRecord(value["coverage"]) &&
  hasExactFields(value["coverage"], COVERAGE_FIELDS) &&
  (value["coverage"]["status"] === "full" ||
    value["coverage"]["status"] === "partial") &&
  Array.isArray(value["coverage"]["gaps"]) &&
  value["coverage"]["gaps"].every(isInspectionGap);

const isProvider = (value: unknown): value is PdfRasterProvider =>
  isRecord(value) &&
  hasExactFields(value, PROVIDER_FIELDS) &&
  typeof value["providerId"] === "string" &&
  typeof value["rendererName"] === "string" &&
  typeof value["rendererVersion"] === "string" &&
  typeof value["ocrName"] === "string" &&
  typeof value["ocrVersion"] === "string" &&
  typeof value["ocrLanguage"] === "string";

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const isCertificate = (value: unknown): value is PdfRasterRewriteCertificate =>
  isRecord(value) &&
  hasExactFields(value, CERTIFICATE_FIELDS) &&
  value["contractVersion"] === 1 &&
  isNonNegativeInteger(value["pageCount"]) &&
  isSha256(value["sourceSha256"]) &&
  isSha256(value["outputSha256"]) &&
  isProvider(value["provider"]) &&
  isNonNegativeInteger(value["detectionCount"]) &&
  isNonNegativeInteger(value["mappedRegionCount"]) &&
  value["structurePixelRewriteVerified"] === true &&
  value["providerAssertedCoverage"] ===
    "complete-rendering-and-ocr-observation" &&
  value["piiCleanGuaranteed"] === false &&
  typeof value["limitation"] === "string";

export const decodePdfInspection = (json: string): PdfInspection => {
  const value: unknown = JSON.parse(json);
  if (!isInspection(value)) {
    throw new Error("Native PDF inspection does not match contract version 1");
  }
  return value;
};

export const decodePdfRasterRewriteCertificate = (
  json: string,
): PdfRasterRewriteCertificate => {
  const value: unknown = JSON.parse(json);
  if (!isCertificate(value)) {
    throw new Error(
      "Native PDF raster certificate does not match contract version 1",
    );
  }
  return value;
};
