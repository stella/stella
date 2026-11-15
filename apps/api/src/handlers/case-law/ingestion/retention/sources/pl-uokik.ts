/** The register keeps PDFs beside its text envelope; project the original sidecar bytes. */
import { panic } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
  type RetentionProjectionContext,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import {
  PDF_PROJECTION_MAX_BYTES,
  projectPdfText,
} from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/**
 * `Ŝ` stands for `ż` in the text layer of documents typeset with a common
 * Polish font encoding (`NajwyŜszy`, `moŜe`); Polish writes no `Ŝ`, so the
 * projection reads each line as the page prints it.
 */
const asPrinted = (text: string): string => text.replaceAll("Ŝ", "ż");

const projectPlUokik = async (
  sourceRaw: string,
  { sourceRawObjects }: RetentionProjectionContext,
): Promise<RetentionProjection> => {
  if (decodeSourceRawEnvelope(sourceRaw) === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const files = Object.values(sourceRawObjects);
  if (files.length === 0) {
    return {
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
    };
  }
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes.byteLength;
    if (bytes > PDF_PROJECTION_MAX_BYTES) {
      return {
        type: "no-text",
        reason: RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET,
      };
    }
  }
  const paragraphs: string[] = [];
  for (const file of files) {
    const projection = await projectPdfText(file.bytes);
    if (projection.type !== "source") {
      return projection;
    }
    if (typeof projection.source === "string") {
      return panic("The PDF projection must return text paragraphs");
    }
    paragraphs.push(...projection.source.paragraphs.map(asPrinted));
  }
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs },
    options: { hyphenatedLineBreaks: true },
  };
};

export const plUokikRetention: RetentionPolicy = {
  type: "checked",
  project: projectPlUokik,
};
