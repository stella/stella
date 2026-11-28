import { decodeSourceRawEnvelope } from "@stll/case-law-ingestion-core/source-raw-envelope";
/**
 * What sbirka.nsoud.cz served as a collection entry's text.
 *
 * The adapter stores the entry's detail page as `detail`. The page's labelled
 * table ends with an unlabelled row whose cell opens with the heading
 * "Sbírkový text rozhodnutí" and holds the collection's text of the decision;
 * that cell, its heading included, is the text. The labelled rows above it are
 * the entry's metadata and headnote, which the row stores apart.
 */
import { load } from "@stll/html";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";

/** The envelope part the adapter stores the detail page under. */
const DETAIL_PART = "detail";

/** The heading block that opens the text cell. */
const TEXT_HEADING = ".detail-section__table-heading";

const projectCzNsSbirka = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const html = parts[DETAIL_PART];
  if (html === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const $ = load(html);
  const cell = $(`table.content-table ${TEXT_HEADING}`).first().parent();
  if (cell.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  // The heading is the publisher's and the document keeps it; a cell holding
  // nothing beneath it holds no text.
  const body = cell.clone();
  body.children(TEXT_HEADING).remove();
  return htmlParagraphs(body.html() ?? "").length === 0
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : {
        type: "source",
        source: {
          type: "paragraphs",
          paragraphs: htmlParagraphs(cell.html() ?? ""),
        },
      };
};

export const czNsSbirkaRetention = {
  type: "checked",
  project: async (sourceRaw: string) =>
    await Promise.resolve(projectCzNsSbirka(sourceRaw)),
} as const satisfies RetentionPolicy;
