/**
 * OCR result shapes: validation of untrusted page geometry at the subprocess
 * boundary and assembly of the bounded plain-text projection from validated
 * pages.
 */

import { TaggedError } from "better-result";

import type {
  DocumentOcrLine,
  DocumentOcrPage,
  DocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import {
  OCR_MAX_PAGES,
  serializeDocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import { LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const PAGE_SEPARATOR = "\n\n\f\n\n";

export const OCR_TIMEOUT_MS = 30 * 60 * 1000;

export class DocumentOcrError extends TaggedError("DocumentOcrError")<{
  code:
    | "not_configured"
    | "request_failed"
    | "invalid_response"
    | "response_too_large"
    | "page_limit_exceeded"
    | "empty_result";
  message: string;
  cause?: unknown;
}> {}

export const isSupportedOcrPageCount = (pageCount: number): boolean =>
  pageCount > 0 && pageCount <= OCR_MAX_PAGES;

/** Post-recognition invariants enforced at the worker boundary. */
export const validateOcrResult = (
  parsed: DocumentOcrResult,
): DocumentOcrResult => {
  validateOcrPageObservationResult(parsed);
  if (parsed.text.trim().length === 0) {
    throw new DocumentOcrError({
      code: "empty_result",
      message: "OCR found no searchable text",
    });
  }
  return parsed;
};

/** Validate complete page observations even when no text was recognized. */
export const validateOcrPageObservationResult = (
  parsed: DocumentOcrResult,
): DocumentOcrResult => {
  if (!isSupportedOcrPageCount(parsed.pageCount)) {
    throw new DocumentOcrError({
      code: "page_limit_exceeded",
      message: `OCR supports PDFs up to ${OCR_MAX_PAGES} pages`,
    });
  }
  const payloadBytes = new TextEncoder().encode(
    serializeDocumentOcrPayload(parsed.payload),
  ).byteLength;
  if (payloadBytes > LIMITS.documentOcrPayloadMaxBytes) {
    throw new DocumentOcrError({
      code: "response_too_large",
      message: "OCR page geometry exceeded the allowed size",
    });
  }
  return parsed;
};

export type DocumentOcrResult = {
  pageCount: number;
  payload: DocumentOcrPayload;
  text: string;
  truncated: boolean;
};

export const parseOcrBox = (
  value: unknown,
  width: number,
  height: number,
): readonly [number, number, number, number] | null => {
  if (
    !isUnknownArray(value) ||
    value.length !== 4 ||
    !value.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }

  const [xMin, yMin, xMax, yMax] = value;
  if (
    typeof xMin !== "number" ||
    typeof yMin !== "number" ||
    typeof xMax !== "number" ||
    typeof yMax !== "number" ||
    xMin < 0 ||
    yMin < 0 ||
    xMax <= xMin ||
    yMax <= yMin ||
    xMax > width ||
    yMax > height
  ) {
    return null;
  }

  return [xMin, yMin, xMax, yMax];
};

const parseOcrLine = (
  value: unknown,
  width: number,
  height: number,
): DocumentOcrLine | null => {
  if (!isRecord(value)) {
    return null;
  }
  const text = value["text"];
  const confidence = value["confidence"];
  const box = parseOcrBox(value["box"], width, height);
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    box === null
  ) {
    return null;
  }
  return { box, confidence, text: text.trim() };
};

/**
 * Producer-side counterpart of `parseOcrPage`: normalize recognized line
 * geometry in fractional PDF point space into the serializable page shape.
 * Dimensions round to integers; boxes clamp to the rounded page; a line
 * that clamping collapses is dropped. Keeping this beside the validator
 * pins the invariant that a page built here always parses — the property
 * test asserts that fixed point for arbitrary geometry.
 */
export const buildOcrPage = ({
  lines,
  pointHeight,
  pointWidth,
}: {
  lines: DocumentOcrLine[];
  pointHeight: number;
  pointWidth: number;
}): DocumentOcrPage => {
  const width = Math.max(1, Math.round(pointWidth));
  const height = Math.max(1, Math.round(pointHeight));
  const clamped = lines.flatMap((line) => {
    const [x0, y0, x1, y1] = line.box;
    const box: DocumentOcrLine["box"] = [
      Math.min(Math.max(0, x0), width),
      Math.min(Math.max(0, y0), height),
      Math.min(Math.max(0, x1), width),
      Math.min(Math.max(0, y1), height),
    ];
    if (box[2] <= box[0] || box[3] <= box[1]) {
      return [];
    }
    return [{ ...line, box }];
  });
  return { height, lines: clamped, width };
};

/**
 * Validate one page of untrusted OCR output. Rejecting the whole page on
 * any malformed line keeps a corrupted boundary from persisting partial
 * geometry as if it were complete.
 */
export const parseOcrPage = (value: unknown): DocumentOcrPage | null => {
  if (!isRecord(value)) {
    return null;
  }
  const width = value["width"];
  const height = value["height"];
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !isUnknownArray(value["lines"])
  ) {
    return null;
  }
  const lines: DocumentOcrLine[] = [];
  for (const lineValue of value["lines"]) {
    const line = parseOcrLine(lineValue, width, height);
    if (line === null) {
      return null;
    }
    lines.push(line);
  }
  return { height, lines, width };
};

/**
 * Assemble the bounded plain-text projection from validated pages. Text
 * is truncated at `extractedContentMaxChars`; the payload always keeps
 * the complete line geometry.
 */
export const assembleDocumentOcrResult = (
  pages: DocumentOcrPage[],
): DocumentOcrResult => {
  const textParts: string[] = [];
  let accumulatedChars = 0;
  let truncated = false;
  for (const [pageIndex, page] of pages.entries()) {
    const pagePrefix = pageIndex === 0 ? "" : PAGE_SEPARATOR;
    const boundedPagePrefix = pagePrefix.slice(
      0,
      Math.max(0, LIMITS.extractedContentMaxChars - accumulatedChars),
    );
    textParts.push(boundedPagePrefix);
    accumulatedChars += boundedPagePrefix.length;
    truncated ||= boundedPagePrefix.length < pagePrefix.length;

    for (const [lineIndex, line] of page.lines.entries()) {
      const separator = lineIndex > 0 ? "\n" : "";
      const remainingChars = LIMITS.extractedContentMaxChars - accumulatedChars;
      if (remainingChars <= 0) {
        truncated = true;
        continue;
      }
      const segment = `${separator}${line.text}`;
      const boundedSegment = segment.slice(0, remainingChars);
      const boundedText = boundedSegment.slice(separator.length);
      if (boundedText.length === 0) {
        truncated = true;
        continue;
      }
      textParts.push(boundedSegment);
      accumulatedChars += boundedSegment.length;
      truncated ||= boundedText.length < line.text.length;
    }
  }

  return {
    pageCount: pages.length,
    payload: { pages, version: 1 },
    text: textParts.join(""),
    truncated,
  };
};
