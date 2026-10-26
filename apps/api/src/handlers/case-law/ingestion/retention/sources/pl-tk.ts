/**
 * What the Constitutional Tribunal portal served for one ruling.
 *
 * The stored raw is an envelope of two parts: `listing`, the listed row as
 * JSON (it names the ruling's document id), and `case-page`, the case page
 * as the portal served it. One case page carries every ruling of its case,
 * each in its own tab, and a ruling's text is the container
 * `id="tekst_<document id>"` inside that tab; the rest of the page is the
 * case record, the other rulings and the portal's navigation.
 */
import { Result } from "better-result";
import * as cheerio from "cheerio";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const LISTING_PART = "listing";
const CASE_PAGE_PART = "case-page";
const TEXT_ID_PREFIX = "tekst_";

/**
 * The portal's footnote widgets inside the text: each popup holds a note the
 * ruling keeps as metadata rather than as body text, and each marker that
 * opens one is a bare `*` or number with no words of its own.
 */
const FOOTNOTE_WIDGETS = '.ui-tooltip, a[id*="tooltip"]';

const documentIdOf = (listing: string): string | undefined => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(listing),
    catch: () => null,
  }).unwrapOr(null);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("documentId" in parsed) ||
    typeof parsed.documentId !== "string" ||
    parsed.documentId.length === 0
  ) {
    return undefined;
  }
  return parsed.documentId;
};

export const projectPlTkSourceRaw = (
  sourceRaw: string,
): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const listing = parts[LISTING_PART];
  const documentId = listing === undefined ? undefined : documentIdOf(listing);
  if (documentId === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const casePage = parts[CASE_PAGE_PART];
  if (casePage === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const $ = cheerio.load(casePage);
  // Compared as an attribute value rather than built into a selector: the id
  // comes from stored data, and the portal's ids carry `:` that a selector
  // would read as syntax.
  const wanted = `${TEXT_ID_PREFIX}${documentId}`;
  const text = $(`[id^="${TEXT_ID_PREFIX}"]`)
    .filter((_, element) => $(element).attr("id") === wanted)
    .first();
  if (text.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  text.find(FOOTNOTE_WIDGETS).remove();
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs: htmlParagraphs($.html(text)) },
  };
};

export const plTkRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) =>
    await Promise.resolve(projectPlTkSourceRaw(sourceRaw)),
};
