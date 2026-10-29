/**
 * What vyhledavac.nssoud.cz served as a Supreme Administrative Court
 * decision's text.
 *
 * The portal serves the decision as an Aspose.Words HTML export
 * (`/DokumentOriginal/Html/{id}`): a standalone document whose body is the
 * decision and nothing else, so the whole body is the text. Its running
 * headers and footers are marked with `-aw-headerfooter-type`, which the
 * oracle drops itself.
 *
 * Where the portal had no rich document, the plain-text endpoint
 * (`/DokumentOriginal/Text/{id}`) answered instead; that text is kept as its
 * own part, one line per paragraph. No document is built from it today, so
 * its projection is only reached once one is. Rows stored before the envelope hold the
 * rich document alone, as bare HTML.
 */
import * as cheerio from "cheerio";

import {
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope parts the adapter stores the two document endpoints under. */
const DOCUMENT_PART = "document";
const TEXT_PART = "text";

const bodyOf = (html: string): string => {
  const $ = cheerio.load(html);
  return `<html><body>${$("body").html() ?? ""}</body></html>`;
};

const projectCzNss = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    // A pre-envelope row: the stored raw is the rich document itself.
    return {
      type: "source",
      source: {
        type: "paragraphs",
        paragraphs: htmlParagraphs(bodyOf(sourceRaw)),
      },
    };
  }
  const html = parts[DOCUMENT_PART];
  if (html !== undefined) {
    return {
      type: "source",
      source: { type: "paragraphs", paragraphs: htmlParagraphs(bodyOf(html)) },
    };
  }
  const text = parts[TEXT_PART];
  if (text === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  // The endpoint's text can carry `<br>` and entities, so it is read as markup
  // and its lines are the paragraphs.
  const $ = cheerio.load(text);
  $("br").replaceWith("\n");
  const paragraphs = $.root()
    .text()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return paragraphs.length === 0
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const czNssRetention: RetentionPolicy = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectCzNss(sourceRaw)),
};
