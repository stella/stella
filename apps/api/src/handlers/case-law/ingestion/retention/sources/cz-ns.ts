/**
 * What rozhodnuti.nsoud.cz served as a Supreme Court decision's text.
 *
 * The court serves each decision as two Domino pages: the detail page
 * (`WebSearch`) and the print page (`WebPrint`). The print page is the one
 * that carries the decision as a document, so it is the text. Its body opens
 * with the metadata table (`#box-table-a`: court, dates, docket, keywords),
 * which is the record's metadata rather than decision text, and is left out;
 * everything else in the body is the decision.
 *
 * Rows stored since the raw became an envelope hold the pages as named parts;
 * rows stored before hold a JSON record with both pages under `webHtml` and
 * `printHtml`.
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
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part the adapter stores the print page under. */
const PRINT_PART = "print";
/** The key a pre-envelope record held the print page under. */
const LEGACY_PRINT_KEY = "printHtml";

/** The print page, or why the stored raw holds none. */
const printPageOf = (
  sourceRaw: string,
): { type: "page"; html: string } | RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts !== null) {
    const html = parts[PRINT_PART];
    return html === undefined
      ? {
          type: "unreadable",
          reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
        }
      : { type: "page", html };
  }
  const legacy = Result.try({
    try: (): unknown => JSON.parse(sourceRaw),
    catch: () => null,
  }).unwrapOr(null);
  const html = isRecord(legacy) ? legacy[LEGACY_PRINT_KEY] : undefined;
  return typeof html === "string"
    ? { type: "page", html }
    : {
        type: "unreadable",
        reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
      };
};

const projectCzNs = (sourceRaw: string): RetentionProjection => {
  const page = printPageOf(sourceRaw);
  if (page.type !== "page") {
    return page;
  }
  if (page.html.trim().length === 0) {
    // The adapter stores an empty print part where the court served no print
    // page, and builds no document from it.
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const $ = cheerio.load(page.html);
  const body = $("body");
  body.find("#box-table-a").remove();
  return {
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: htmlParagraphs(body.html() ?? ""),
    },
  };
};

export const czNsRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectCzNs(sourceRaw)),
};
