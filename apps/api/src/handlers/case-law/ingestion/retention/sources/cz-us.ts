/**
 * What nalus.usoud.cz served as a Constitutional Court decision's text.
 *
 * The document page (`GetText.aspx`) renders the decision in its `.DocContent`
 * region, one paragraph per run of text between `<br/>` breaks; everything
 * around that region is the portal's navigation and record furniture. The
 * page also embeds the same decision as RTF in the hidden `#docContentHidden`
 * field, which is what the parser reads. The visible region is taken here
 * instead: it is the text the court shows a reader, and reading it needs no
 * RTF decoder, which stays confined to its one owner (`rtf-reader.ts`).
 *
 * Rows stored since the raw became an envelope hold the page as the
 * `document` part; rows stored before hold either the page itself or a JSON
 * record with the page under `textHtml`.
 */
import { Result } from "better-result";
import * as cheerio from "cheerio";

import {
  RETENTION_PROJECTION_FAILURE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part the adapter stores the document page under. */
const DOCUMENT_PART = "document";
/** The key a pre-envelope JSON record held the document page under. */
const LEGACY_TEXT_KEY = "textHtml";

/** The document page, whichever shape the row was stored in. */
const documentPageOf = (sourceRaw: string): string | undefined => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts !== null) {
    return parts[DOCUMENT_PART];
  }
  const legacy = Result.try({
    try: (): unknown => JSON.parse(sourceRaw),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(legacy)) {
    // Not JSON at all: the row holds the page itself.
    return sourceRaw;
  }
  const html = legacy[LEGACY_TEXT_KEY];
  return typeof html === "string" ? html : undefined;
};

const projectCzUs = (sourceRaw: string): RetentionProjection => {
  const html = documentPageOf(sourceRaw);
  if (html === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const $ = cheerio.load(html);
  const region = $(".DocContent").first();
  if (region.length === 0) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  region.find("script, style").remove();
  // A break, and the end of any block, ends the line it closes; without them
  // the last word of one paragraph and the first of the next run together.
  region.find("br").replaceWith("\n");
  region.find("p, div, tr, li").after("\n");
  const paragraphs = region
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  return { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const czUsRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectCzUs(sourceRaw)),
};
