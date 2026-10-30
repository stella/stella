/**
 * Retention projection for the Polish common courts (SAOS).
 *
 * The stored raw is an envelope of the responses read for one judgment: the
 * listing row under `listing-dump` or `listing-search` (the record itself),
 * and, where the per-judgment request answered, the whole response under
 * `detail` (the record wrapped in `data`). The decision text is the record's
 * `textContent`, the detail's where it states one and the listing row's
 * otherwise, because the adapter builds the document from that same choice.
 *
 * SAOS serves `textContent` either as an HTML fragment holding the judgment
 * alone, with no page around it, or as legacy plain text for older
 * judgments. The fragment is the content region as served; plain text is
 * handed over line by line, so every line break stays a word boundary.
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

const LISTING_PARTS = ["listing-dump", "listing-search"] as const;
const DETAIL_PART = "detail";

/** Any element tag: what tells SAOS's HTML fragments from its plain text. */
const HTML_TAG = /<[a-z][\s\S]*>/iu;

type RecordRead =
  | { readonly type: "absent" }
  | { readonly type: "record"; readonly record: Record<string, unknown> }
  | { readonly type: "unreadable" };

/**
 * One part back as the judgment record it holds. The detail part is the
 * publisher's whole answer and wraps the record in `data`; a listing part is
 * the record itself.
 */
const readRecord = (part: string | undefined): RecordRead => {
  if (part === undefined) {
    return { type: "absent" };
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(part),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(parsed)) {
    return { type: "unreadable" };
  }
  const data = parsed["data"];
  return { type: "record", record: isRecord(data) ? data : parsed };
};

const textContentOf = (read: RecordRead): string | undefined => {
  if (read.type !== "record") {
    return undefined;
  }
  const text = read.record["textContent"];
  return typeof text === "string" ? text : undefined;
};

const projectPlCourts = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const listingPart = LISTING_PARTS.flatMap((name) => {
    const part = parts[name];
    return part === undefined ? [] : [part];
  }).at(0);
  const listing = readRecord(listingPart);
  const detail = readRecord(parts[DETAIL_PART]);
  if (listing.type !== "record" || detail.type === "unreadable") {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const text = textContentOf(detail) ?? textContentOf(listing);
  if (text === undefined || text.trim().length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  if (HTML_TAG.test(text)) {
    return {
      type: "source",
      source: { type: "paragraphs", paragraphs: htmlParagraphs(text) },
    };
  }
  return {
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: text.split(/\r?\n/u).filter((line) => line.trim() !== ""),
    },
  };
};

export const plCourtsRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectPlCourts(sourceRaw)),
};
