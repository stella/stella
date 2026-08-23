import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  DOCX_PART_TYPES,
  DOCX_EXTRACTION_ERROR_CODES,
  DOCX_REWRITE_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxBlockLocation,
  type DocxExtractionErrorCode,
  type DocxRewriteErrorCode,
  type DocxRewriteResult,
} from "./types";
import {
  DOCX_UNCOMPRESSED_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
} from "./extract";

export class DocxRewriteError extends Error {
  readonly code: DocxRewriteErrorCode;

  constructor(code: DocxRewriteErrorCode, message: string) {
    super(message);
    this.name = "DocxRewriteError";
    this.code = code;
  }
}

const REWRITE_ERROR_CODES = new Set<DocxRewriteErrorCode>(
  Object.values(DOCX_REWRITE_ERROR_CODES),
);
const EXTRACTION_ERROR_CODES = new Set<DocxExtractionErrorCode>(
  Object.values(DOCX_EXTRACTION_ERROR_CODES),
);
const DOCX_REWRITE_MAX_BLOCKS = 100_000;
const DOCX_REWRITE_MAX_REPLACEMENTS = 1_000_000;

const invalidLocation = (message: string): never => {
  throw new DocxRewriteError(
    DOCX_REWRITE_ERROR_CODES.invalidReplacement,
    message,
  );
};

const ownDataRecord = (value: unknown, fields?: readonly string[]): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidLocation("DOCX rewrite locations must be plain objects");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidLocation("DOCX rewrite locations must be plain objects");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    (fields !== undefined &&
      (keys.length !== fields.length ||
        keys.some((key) => typeof key !== "string" || !fields.includes(key))))
  ) {
    return invalidLocation(
      "DOCX rewrite locations must contain exactly their declared fields",
    );
  }
  for (const field of fields ?? keys) {
    if (typeof field !== "string") {
      return invalidLocation(
        "DOCX rewrite locations must contain string fields",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidLocation(
        "DOCX rewrite locations must contain own data properties",
      );
    }
  }
  return value;
};

const ownValue = (record: object, field: string): unknown =>
  Object.getOwnPropertyDescriptor(record, field)?.value;

const isDocxPartType = (
  value: unknown,
): value is DocxBlockLocation["part"]["type"] =>
  Object.values(DOCX_PART_TYPES).some((type) => type === value);

const copyPath = (path: unknown): number[] => {
  if (!Array.isArray(path)) {
    return invalidLocation("DOCX rewrite location paths must be arrays");
  }
  if (path.length > DOCX_XML_MAX_DEPTH) {
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      `DOCX rewrite location paths must not exceed ${DOCX_XML_MAX_DEPTH} entries`,
    );
  }
  const copy: number[] = [];
  for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(path, pathIndex);
    const index = descriptor?.value;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX rewrite location paths must contain non-negative integers",
      );
    }
    copy.push(index);
  }
  return copy;
};

const copyLocation = (location: unknown): DocxBlockLocation => {
  const candidate = ownDataRecord(location);
  const type = ownValue(candidate, "type");
  const fields = ["type", "part", "blockIndex", "xmlPath"];
  if (type === "table-cell-paragraph") {
    fields.push("tablePath", "rowPath", "cellPath");
  } else if (type === "text-box-paragraph") {
    fields.push("textBoxPath");
  }
  if (Object.hasOwn(candidate, "toJSON")) {
    fields.push("toJSON");
  }
  const base = ownDataRecord(location, fields);
  const partRecord = ownDataRecord(ownValue(base, "part"), ["type", "path"]);
  const partType = ownValue(partRecord, "type");
  const partPath = ownValue(partRecord, "path");
  const blockIndex = ownValue(base, "blockIndex");
  if (
    !isDocxPartType(partType) ||
    typeof partPath !== "string" ||
    !Number.isSafeInteger(blockIndex) ||
    typeof blockIndex !== "number" ||
    blockIndex < 0
  ) {
    return invalidLocation(
      "DOCX rewrite locations must contain a known type, part, and block index",
    );
  }
  const part = { type: partType, path: partPath };
  switch (type) {
    case "paragraph":
      return {
        type,
        part,
        blockIndex,
        xmlPath: copyPath(ownValue(base, "xmlPath")),
      };
    case "table-cell-paragraph":
      return {
        type,
        part,
        blockIndex,
        xmlPath: copyPath(ownValue(base, "xmlPath")),
        tablePath: copyPath(ownValue(base, "tablePath")),
        rowPath: copyPath(ownValue(base, "rowPath")),
        cellPath: copyPath(ownValue(base, "cellPath")),
      };
    case "text-box-paragraph":
      return {
        type,
        part,
        blockIndex,
        xmlPath: copyPath(ownValue(base, "xmlPath")),
        textBoxPath: copyPath(ownValue(base, "textBoxPath")),
      };
    default:
      return invalidLocation(
        "DOCX rewrite locations must use a known location type",
      );
  }
};

const preflightRewritePlan = (
  rewrites: readonly DocxBlockRewrite[],
): readonly DocxBlockRewrite[] => {
  const rewriteCount = rewrites.length;
  if (rewriteCount > DOCX_REWRITE_MAX_BLOCKS) {
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `DOCX rewrites must not contain more than ${DOCX_REWRITE_MAX_BLOCKS} blocks`,
    );
  }
  let replacementCount = 0;
  let estimatedBytes = rewriteCount * 256;
  const serializableRewrites: DocxBlockRewrite[] = [];
  for (let rewriteIndex = 0; rewriteIndex < rewriteCount; rewriteIndex += 1) {
    const rewrite = rewrites[rewriteIndex];
    if (rewrite === undefined) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX rewrite plans must not contain sparse blocks",
      );
    }
    if (!Array.isArray(rewrite.replacements)) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX block rewrite replacements must be an array",
      );
    }
    const blockReplacementCount = rewrite.replacements.length;
    replacementCount += blockReplacementCount;
    if (replacementCount > DOCX_REWRITE_MAX_REPLACEMENTS) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrites must not contain more than ${DOCX_REWRITE_MAX_REPLACEMENTS} replacements`,
      );
    }
    if (typeof rewrite.expectedText !== "string") {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX block rewrite expectedText must be a string",
      );
    }
    estimatedBytes +=
      rewrite.expectedText.length * 6 + blockReplacementCount * 96;
    const replacements: DocxBlockRewrite["replacements"][number][] = [];
    for (
      let replacementIndex = 0;
      replacementIndex < blockReplacementCount;
      replacementIndex += 1
    ) {
      const replacement = rewrite.replacements[replacementIndex];
      if (replacement === undefined) {
        throw new DocxRewriteError(
          DOCX_REWRITE_ERROR_CODES.invalidReplacement,
          "DOCX rewrite plans must not contain sparse replacements",
        );
      }
      if (
        !Number.isSafeInteger(replacement.start) ||
        replacement.start < 0 ||
        !Number.isSafeInteger(replacement.end) ||
        replacement.end < replacement.start ||
        typeof replacement.replacement !== "string"
      ) {
        throw new DocxRewriteError(
          DOCX_REWRITE_ERROR_CODES.invalidReplacement,
          "DOCX replacements require ordered non-negative integer offsets and string values",
        );
      }
      estimatedBytes += replacement.replacement.length * 6;
      replacements.push({
        start: replacement.start,
        end: replacement.end,
        replacement: replacement.replacement,
      });
    }
    const { location } = rewrite;
    const serializableLocation = copyLocation(location);
    estimatedBytes +=
      (serializableLocation.type.length +
        serializableLocation.part.type.length +
        serializableLocation.part.path.length) *
      6;
    estimatedBytes += serializableLocation.xmlPath.length * 24;
    switch (serializableLocation.type) {
      case "paragraph":
        break;
      case "table-cell-paragraph":
        estimatedBytes +=
          (serializableLocation.tablePath.length +
            serializableLocation.rowPath.length +
            serializableLocation.cellPath.length) *
          24;
        break;
      case "text-box-paragraph":
        estimatedBytes += serializableLocation.textBoxPath.length * 24;
        break;
    }
    serializableRewrites.push({
      location: serializableLocation,
      expectedText: rewrite.expectedText,
      replacements,
    });
    if (estimatedBytes > DOCX_UNCOMPRESSED_MAX_BYTES) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrite plans must not exceed ${DOCX_UNCOMPRESSED_MAX_BYTES} estimated serialized bytes`,
      );
    }
  }
  return serializableRewrites;
};

export const rewriteDocxText = (
  archive: Uint8Array,
  rewrites: readonly DocxBlockRewrite[],
): DocxRewriteResult => {
  const rewrite = loadNativeAnonymizeBinding().rewriteDocxTextNative;
  if (rewrite === undefined) {
    throw new Error(
      "The native anonymize binding does not expose DOCX rewriting",
    );
  }
  let serializableRewrites: readonly DocxBlockRewrite[];
  try {
    serializableRewrites = preflightRewritePlan(rewrites);
  } catch (error) {
    if (error instanceof DocxRewriteError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      `DOCX rewrite plan is invalid: ${message}`,
    );
  }
  let rewritesJson: string;
  try {
    rewritesJson = JSON.stringify(serializableRewrites);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      `DOCX rewrite plan is not serializable: ${message}`,
    );
  }
  try {
    return rewrite(archive, rewritesJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const separator = message.indexOf(": ");
    const rawCode = message.slice(0, separator);
    const extractionCode = rawCode as DocxExtractionErrorCode;
    if (separator > 0 && EXTRACTION_ERROR_CODES.has(extractionCode)) {
      throw new DocxExtractionError(
        extractionCode,
        message.slice(separator + 2),
      );
    }
    const code = rawCode as DocxRewriteErrorCode;
    if (separator > 0 && REWRITE_ERROR_CODES.has(code)) {
      throw new DocxRewriteError(code, message.slice(separator + 2));
    }
    throw error;
  }
};
