/**
 * Retention projection for the Court of Justice of the Federal District and
 * Territories (TJDFT).
 *
 * The adapter stores the listing row as `listing` and, once the record is
 * read, the search's one-record answer verbatim as `detail`
 * (`{ registros: [record], ... }`). The decision's text is read from that
 * record, in the order the court publishes it:
 *
 * - the full text as markup, `inteiroTeorHtml`;
 * - else the full text as preformatted plain text, `inteiroTeor`;
 * - else the record itself: the headnote `ementa` and the operative `decisao`.
 *
 * The court serves "Inteiro Teor indisponível." in place of a full text it
 * does not publish. A row stored without its detail answer is a listing whose
 * text was never read, so it builds no document and never reaches the check.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part the one-record search answer is stored under. */
const DETAIL_PART = "detail";

/** The literal the court serves in place of a full text it does not publish. */
const TEXT_PLACEHOLDER = "Inteiro Teor indisponível.";

/** A field's text, or nothing where it is empty or the court's placeholder. */
const textOf = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() !== TEXT_PLACEHOLDER
    ? value
    : undefined;
};

const plainParagraphs = (value: string): string[] =>
  value
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** The record's text as the court published it, or null when it has none. */
const recordParagraphs = (record: Record<string, unknown>): string[] | null => {
  const html = textOf(record, "inteiroTeorHtml");
  if (html !== undefined) {
    return htmlParagraphs(html);
  }
  const text = textOf(record, "inteiroTeor");
  if (text !== undefined) {
    return plainParagraphs(text);
  }
  const stated = [textOf(record, "ementa"), textOf(record, "decisao")].filter(
    (value) => value !== undefined,
  );
  return stated.length === 0 ? null : stated.flatMap(plainParagraphs);
};

const projectBrTjdft = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const detail = parts[DETAIL_PART];
  if (detail === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const answer = Result.try({
    try: (): unknown => JSON.parse(detail),
    catch: () => null,
  }).unwrapOr(null);
  const rows = isRecord(answer) ? answer["registros"] : undefined;
  const record: unknown = Array.isArray(rows) ? rows.at(0) : undefined;
  if (!isRecord(record)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const paragraphs = recordParagraphs(record);
  return paragraphs === null
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const brTjdftRetention = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectBrTjdft(sourceRaw)),
} as const satisfies RetentionPolicy;
