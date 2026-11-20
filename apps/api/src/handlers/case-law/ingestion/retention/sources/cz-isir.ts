/**
 * What the insolvency register served as a decision's text.
 *
 * The adapter never stores the register's PDF: it stores the document's
 * paragraphs after anonymisation, as a JSON list of `{ text, bold }` under
 * the envelope part `text`, and the decision is parsed from that list. The
 * list is therefore the publisher's text as the corpus may hold it, and the
 * projection reads it back paragraph by paragraph.
 */
import { Result } from "better-result";
import * as v from "valibot";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope parts the adapter stores the anonymised paragraphs and the action under. */
const TEXT_PART = "text";
const ACTION_PART = "action";

const paragraphsSchema = v.array(
  v.strictObject({ text: v.string(), bold: v.boolean() }),
);

const parsedJson = (text: string): unknown =>
  Result.try((): unknown => JSON.parse(text)).unwrapOr(null);

const projectCzIsir = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const text = parts[TEXT_PART];
  if (text === undefined) {
    // A listing kept while its document could not be read stores the action
    // alone: a decision without text, not an unreadable one.
    return parts[ACTION_PART] === undefined
      ? {
          type: "unreadable",
          reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
        }
      : { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const parsed = v.safeParse(paragraphsSchema, parsedJson(text));
  if (!parsed.success) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const paragraphs = parsed.output
    .map(({ text: paragraph }) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.length === 0
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const czIsirRetention = {
  type: "checked",
  project: async (sourceRaw: string) =>
    await Promise.resolve(projectCzIsir(sourceRaw)),
} as const satisfies RetentionPolicy;
