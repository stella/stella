import {
  DOCX_PART_TYPES,
  type DocxBlockLocation,
  type DocxBlockRewrite,
  type DocxCoverage,
  type DocxCoverageItem,
  type DocxExtraction,
  type DocxInlineContext,
  type DocxPart,
  type DocxTextBlock,
  type DocxTextSegment,
} from "./types";

type RequiredFields<T> = { [Key in keyof T]-?: true };

const PART_FIELDS = {
  type: true,
  path: true,
} as const satisfies RequiredFields<DocxPart>;
const BASE_LOCATION_FIELDS = {
  type: true,
  part: true,
  blockIndex: true,
  xmlPath: true,
} as const;
const PARAGRAPH_LOCATION_FIELDS = BASE_LOCATION_FIELDS satisfies RequiredFields<
  Extract<DocxBlockLocation, { type: "paragraph" }>
>;
const TABLE_LOCATION_FIELDS = {
  ...BASE_LOCATION_FIELDS,
  tablePath: true,
  rowPath: true,
  cellPath: true,
} as const satisfies RequiredFields<
  Extract<DocxBlockLocation, { type: "table-cell-paragraph" }>
>;
const TEXT_BOX_LOCATION_FIELDS = {
  ...BASE_LOCATION_FIELDS,
  textBoxPath: true,
} as const satisfies RequiredFields<
  Extract<DocxBlockLocation, { type: "text-box-paragraph" }>
>;
const HYPERLINK_CONTEXT_FIELDS = {
  type: true,
  relationshipId: true,
  anchor: true,
} as const satisfies RequiredFields<
  Extract<DocxInlineContext, { type: "hyperlink" }>
>;
const REVISION_CONTEXT_FIELDS = {
  type: true,
  revision: true,
} as const satisfies RequiredFields<
  Extract<DocxInlineContext, { type: "revision" }>
>;
const SEGMENT_FIELDS = {
  start: true,
  end: true,
  source: true,
  contexts: true,
  xmlPath: true,
} as const satisfies RequiredFields<DocxTextSegment>;
const BLOCK_FIELDS = {
  text: true,
  location: true,
  segments: true,
} as const satisfies RequiredFields<DocxTextBlock>;
const EXTRACTED_COVERAGE_FIELDS = {
  status: true,
  part: true,
  blockCount: true,
} as const satisfies RequiredFields<
  Extract<DocxCoverageItem, { status: "extracted" }>
>;
const UNSUPPORTED_COVERAGE_FIELDS = {
  status: true,
  path: true,
  contentType: true,
  reason: true,
} as const satisfies RequiredFields<
  Extract<DocxCoverageItem, { status: "unsupported" }>
>;
const COVERAGE_FIELDS = {
  parts: true,
  hyperlinkTextSegmentCount: true,
  revisionTextSegmentCount: true,
  unsupportedAlternateContentCount: true,
  unsupportedSymbolCount: true,
  unsupportedFieldInstructionCount: true,
} as const satisfies RequiredFields<DocxCoverage>;
const EXTRACTION_FIELDS = {
  contractVersion: true,
  blocks: true,
  coverage: true,
} as const satisfies RequiredFields<DocxExtraction>;

export type DocxRestorationCandidate = {
  start: number;
  end: number;
  candidate: string;
};

export type NativeDocxRestorationPlan = {
  extraction: DocxExtraction;
  blocks: readonly {
    location: DocxBlockRewrite["location"];
    expectedText: string;
    candidates: readonly DocxRestorationCandidate[];
  }[];
  candidateCount: number;
};

const RESTORATION_CANDIDATE_FIELDS = {
  start: true,
  end: true,
  candidate: true,
} as const satisfies RequiredFields<DocxRestorationCandidate>;
const RESTORATION_BLOCK_FIELDS = {
  location: true,
  expectedText: true,
  candidates: true,
} as const satisfies RequiredFields<
  NativeDocxRestorationPlan["blocks"][number]
>;
const RESTORATION_PLAN_FIELDS = {
  extraction: true,
  blocks: true,
  candidateCount: true,
} as const satisfies RequiredFields<NativeDocxRestorationPlan>;

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

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPath = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every(isNonNegativeInteger);

const isPart = (value: unknown): value is DocxPart =>
  isRecord(value) &&
  hasExactFields(value, PART_FIELDS) &&
  Object.values(DOCX_PART_TYPES).some(
    (partType) => partType === value["type"],
  ) &&
  typeof value["path"] === "string";

const hasBaseLocation = (value: Record<string, unknown>): boolean =>
  isPart(value["part"]) &&
  isNonNegativeInteger(value["blockIndex"]) &&
  isPath(value["xmlPath"]);

const isLocation = (value: unknown): value is DocxBlockLocation => {
  if (!isRecord(value) || !hasBaseLocation(value)) {
    return false;
  }
  switch (value["type"]) {
    case "paragraph":
      return hasExactFields(value, PARAGRAPH_LOCATION_FIELDS);
    case "table-cell-paragraph":
      return (
        hasExactFields(value, TABLE_LOCATION_FIELDS) &&
        isPath(value["tablePath"]) &&
        isPath(value["rowPath"]) &&
        isPath(value["cellPath"])
      );
    case "text-box-paragraph":
      return (
        hasExactFields(value, TEXT_BOX_LOCATION_FIELDS) &&
        isPath(value["textBoxPath"])
      );
    default:
      return false;
  }
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isInlineContext = (value: unknown): value is DocxInlineContext => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["type"]) {
    case "hyperlink":
      return (
        hasExactFields(value, HYPERLINK_CONTEXT_FIELDS) &&
        isNullableString(value["relationshipId"]) &&
        isNullableString(value["anchor"])
      );
    case "revision":
      return (
        hasExactFields(value, REVISION_CONTEXT_FIELDS) &&
        (value["revision"] === "deletion" ||
          value["revision"] === "insertion" ||
          value["revision"] === "move-from" ||
          value["revision"] === "move-to")
      );
    default:
      return false;
  }
};

const isSegment = (value: unknown): value is DocxTextSegment =>
  isRecord(value) &&
  hasExactFields(value, SEGMENT_FIELDS) &&
  isNonNegativeInteger(value["start"]) &&
  isNonNegativeInteger(value["end"]) &&
  value["end"] >= value["start"] &&
  (value["source"] === "break" ||
    value["source"] === "tab" ||
    value["source"] === "text") &&
  Array.isArray(value["contexts"]) &&
  value["contexts"].every(isInlineContext) &&
  isPath(value["xmlPath"]);

const isBlock = (value: unknown): value is DocxTextBlock =>
  isRecord(value) &&
  hasExactFields(value, BLOCK_FIELDS) &&
  typeof value["text"] === "string" &&
  isLocation(value["location"]) &&
  Array.isArray(value["segments"]) &&
  value["segments"].every(isSegment);

const isCoverageItem = (value: unknown): value is DocxCoverageItem => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["status"]) {
    case "extracted":
      return (
        hasExactFields(value, EXTRACTED_COVERAGE_FIELDS) &&
        isPart(value["part"]) &&
        isNonNegativeInteger(value["blockCount"])
      );
    case "unsupported":
      return (
        hasExactFields(value, UNSUPPORTED_COVERAGE_FIELDS) &&
        typeof value["path"] === "string" &&
        typeof value["contentType"] === "string" &&
        typeof value["reason"] === "string"
      );
    default:
      return false;
  }
};

const isCoverage = (value: unknown): value is DocxCoverage =>
  isRecord(value) &&
  hasExactFields(value, COVERAGE_FIELDS) &&
  Array.isArray(value["parts"]) &&
  value["parts"].every(isCoverageItem) &&
  isNonNegativeInteger(value["hyperlinkTextSegmentCount"]) &&
  isNonNegativeInteger(value["revisionTextSegmentCount"]) &&
  isNonNegativeInteger(value["unsupportedAlternateContentCount"]) &&
  isNonNegativeInteger(value["unsupportedSymbolCount"]) &&
  isNonNegativeInteger(value["unsupportedFieldInstructionCount"]);

const isExtraction = (value: unknown): value is DocxExtraction =>
  isRecord(value) &&
  hasExactFields(value, EXTRACTION_FIELDS) &&
  value["contractVersion"] === 1 &&
  Array.isArray(value["blocks"]) &&
  value["blocks"].every(isBlock) &&
  isCoverage(value["coverage"]);

const isRestorationCandidate = (
  value: unknown,
): value is DocxRestorationCandidate =>
  isRecord(value) &&
  hasExactFields(value, RESTORATION_CANDIDATE_FIELDS) &&
  isNonNegativeInteger(value["start"]) &&
  isNonNegativeInteger(value["end"]) &&
  value["end"] >= value["start"] &&
  typeof value["candidate"] === "string";

const isRestorationPlan = (
  value: unknown,
): value is NativeDocxRestorationPlan =>
  isRecord(value) &&
  hasExactFields(value, RESTORATION_PLAN_FIELDS) &&
  isExtraction(value["extraction"]) &&
  Array.isArray(value["blocks"]) &&
  value["blocks"].every(
    (block) =>
      isRecord(block) &&
      hasExactFields(block, RESTORATION_BLOCK_FIELDS) &&
      isLocation(block["location"]) &&
      typeof block["expectedText"] === "string" &&
      Array.isArray(block["candidates"]) &&
      block["candidates"].every(isRestorationCandidate),
  ) &&
  isNonNegativeInteger(value["candidateCount"]);

export const decodeDocxExtraction = (json: string): DocxExtraction => {
  const value: unknown = JSON.parse(json);
  if (!isExtraction(value)) {
    throw new Error("Native DOCX extraction does not match contract version 1");
  }
  return value;
};

export const decodeDocxRestorationPlan = (
  json: string,
): NativeDocxRestorationPlan => {
  const value: unknown = JSON.parse(json);
  if (!isRestorationPlan(value)) {
    throw new Error(
      "Native DOCX restoration plan does not match contract version 1",
    );
  }
  return value;
};
