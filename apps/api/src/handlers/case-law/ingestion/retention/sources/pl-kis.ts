/**
 * Retention projection for the Polish tax interpretations service (EUREKA).
 *
 * The stored raw is an envelope with the search row (`listing`) and the
 * document's detail response (`detail`), a JSON record whose
 * `dokument.fields` list states the document text as HTML under
 * `TRESC_INTERESARIUSZ`, or under `TRESC_NEWS` for a newsletter. A document
 * whose HTML field is empty is read from its PDF rendition, stored beside the
 * envelope rather than in it.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plDecisionContentProjection } from "@/api/handlers/case-law/ingestion/retention/sources/pl-decision-content";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

const DETAIL_PART = "detail";
/**
 * The fields a document type states its text in, in the adapter's order:
 * every type but the newsletter uses the first, the newsletter the second.
 */
const TEXT_FIELDS = ["TRESC_INTERESARIUSZ", "TRESC_NEWS"] as const;

/** One HTML field of the detail, `undefined` where the record states none. */
const htmlFieldValue = (
  fields: readonly unknown[],
  key: (typeof TEXT_FIELDS)[number],
): string | undefined => {
  // The service states each key once; were one repeated, the record's last
  // statement of it is the one a reader keyed by name would hold.
  const value = fields
    .flatMap((field: unknown) =>
      isRecord(field) && field["key"] === key ? [field["value"]] : [],
    )
    .at(-1);
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
};

/** The detail's HTML text, `undefined` where the record states none. */
const htmlFieldOf = (detail: unknown): string | undefined => {
  const document = isRecord(detail) ? detail["dokument"] : undefined;
  const fields = isRecord(document) ? document["fields"] : undefined;
  if (!Array.isArray(fields)) {
    return undefined;
  }
  return TEXT_FIELDS.map((key) => htmlFieldValue(fields, key)).find(
    (html) => html !== undefined,
  );
};

const projectPlKis = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const detailText = parts[DETAIL_PART];
  if (detailText === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const detail = Result.try({
    try: (): unknown => JSON.parse(detailText),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(detail)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const html = htmlFieldOf(detail);
  if (html !== undefined) {
    return plDecisionContentProjection(html);
  }
  // The check runs only for a decision with a document, so a detail without
  // its HTML field had its text read from the PDF. The pipeline checks the
  // observation before it writes the PDF, so the envelope does not name it
  // yet and cannot be asked.
  return {
    type: "no-text",
    reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
  };
};

export const plKisRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectPlKis(sourceRaw)),
};
