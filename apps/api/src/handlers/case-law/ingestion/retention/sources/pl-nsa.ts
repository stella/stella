/**
 * Retention projection for the Polish administrative courts' dataset import.
 *
 * The stored raw is an envelope whose `row` part is the dataset row as the
 * reader handed it over, every column under its own name. The decision text
 * is the dataset's `full_text` column, its own rendering of the whole
 * decision. A row without it states the text only in the four section
 * columns, which are then the publisher's text.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part the adapter writes the dataset row under. */
const ROW_PART = "row";

/** The section columns, in the order the court prints the sections. */
const SECTION_COLUMNS = [
  "thesis",
  "sentence",
  "reasons_for_judgment",
  "dissenting_opinion",
] as const;

/** The dataset separates paragraphs inside a column with a blank line. */
const paragraphsOf = (text: string): string[] =>
  text
    .split(/\r?\n(?:[ \t]*\r?\n)+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

const columnText = (
  row: Record<string, unknown>,
  column: string,
): string | undefined => {
  const value = row[column];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
};

const projectPlNsa = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  const rowText = parts?.[ROW_PART];
  if (rowText === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const row = Result.try({
    try: (): unknown => JSON.parse(rowText),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(row)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const fullText = columnText(row, "full_text");
  const texts =
    fullText === undefined
      ? SECTION_COLUMNS.flatMap((column) => {
          const text = columnText(row, column);
          return text === undefined ? [] : [text];
        })
      : [fullText];
  const paragraphs = texts.flatMap(paragraphsOf);
  if (paragraphs.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  return { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const plNsaRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectPlNsa(sourceRaw)),
};
