/**
 * Retention projection for the Court of Justice of the European Union.
 *
 * A row is one language expression of one decision, and the adapter stores
 * every response it read for it in one envelope: the SPARQL binding under
 * `listing`, the branch notice under `notice`, the Formex XML (or an archive
 * of it) under `formex`, and the XHTML manifestation under `document`. The
 * decision's blocks are built from the XHTML alone, in every language; the
 * notice and Formex are read for metadata. So the projection is the XHTML
 * whichever other parts a row carries, and the same rule serves all 24
 * languages because it reads markup, never wording.
 *
 * The XHTML arrives in two shapes. A manifestation served on its own is the
 * decision and nothing else, so its body is the content region. The same
 * converter output is also served embedded in a portal page, which wraps it
 * in the `#document1` container among the site's navigation, language
 * selector, contact block and footer; there the container is the region.
 * Interactive and non-content elements inside the region are removed, as no
 * reader sees them as text.
 */
import * as cheerio from "cheerio";

import {
  RETENTION_PROJECTION_FAILURE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope part the XHTML manifestation is stored under. */
const DOCUMENT_PART = "document";

/** The container the publisher's portal embeds a decision in. */
const PORTAL_DOCUMENT_CONTAINER = "#document1";

/**
 * Elements inside the region that are not document text, the portal's link
 * back to the top of the container among them.
 */
const NON_CONTENT = `script, style, noscript, nav, header, footer, button, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], a[href="${PORTAL_DOCUMENT_CONTAINER}"]`;

const projectEuEcj = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const html = parts[DOCUMENT_PART];
  // The adapter builds no row without the manifestation, so an envelope
  // lacking it is not one this source wrote.
  if (html === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const $ = cheerio.load(html);
  const container = $(PORTAL_DOCUMENT_CONTAINER).first();
  const region = container.length > 0 ? container : $("body");
  region.find(NON_CONTENT).remove();
  return {
    type: "source",
    source: { type: "paragraphs", paragraphs: htmlParagraphs($.html(region)) },
  };
};

export const euEcjRetention = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectEuEcj(sourceRaw)),
} as const satisfies RetentionPolicy;
