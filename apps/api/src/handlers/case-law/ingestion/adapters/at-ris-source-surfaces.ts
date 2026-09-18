/**
 * One surface census for the eleven tribunals this publisher serves.
 *
 * The adapters differ in the application they name in the query and in nothing
 * else: the same endpoints answer for all of them, with the same shapes and
 * the same access policy. Eleven hand-copied censuses would therefore state
 * one fact eleven times and drift the first time one of them is edited, so the
 * census is written once here and each adapter references it under its own
 * key — which is all a backlog entry needs, since that key is what the
 * committed baseline lists.
 */

import type { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  backlogSurface,
  excludedSourceSurface,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { LegacyAdapterKey } from "@/api/lib/legal-search/ingestion-types";

/** The adapters this census speaks for: the tribunals, not the ministry's. */
export type AtRisSurfaceAdapter = Exclude<
  Extract<LegacyAdapterKey, `at-${string}`>,
  typeof ADAPTER_KEYS.AT_FINDOK
>;

/**
 * The listing states the fields; the document states the text. Everything else
 * this publisher serves is a rendering of one of those two, a change feed, or
 * a page behind the bot challenge its guarded host answers automated clients
 * with — which is why no `.wxe` surface may ever sit on the ingestion path.
 */
const SOURCE_SURFACES = [
  "listing",
  "headnote-listing",
  "history",
  "document-xml",
  "document-html",
  "document-rtf",
  "document-pdf",
  "attachments",
  "metadata-card",
  "full-decision-page",
  "headnotes-page",
  "decision-text-page",
  "headnote-chain",
] as const;

export const atRisSourceSurfaces = (
  adapter: AtRisSurfaceAdapter,
): SourceSurfaceCensus => ({
  surfaces: {
    listing: storedSourceSurface("listing"),
    "headnote-listing": storedSourceSurface("headnote-listing"),
    history: excludedSourceSurface(
      "a change and deletion feed: a way to spend fewer requests, not a statement of any field",
    ),
    "document-xml": storedSourceSurface("document-xml"),
    "document-html": excludedSourceSurface(
      "a transform of the same document payload the XML surface carries",
    ),
    "document-rtf": excludedSourceSurface(
      "the same content in a word-processor rendering many times its size",
    ),
    "document-pdf": excludedSourceSurface(
      "a print rendering; it is the only surface carrying page numbering, and nothing downstream reads pages",
    ),
    attachments: backlogSurface(
      adapter,
      "binary part; envelope object references not yet available",
    ),
    "metadata-card": excludedSourceSurface(
      "the same fields the listing states, on a host that answers an automated client with a challenge",
    ),
    "full-decision-page": excludedSourceSurface(
      "the text and every headnote on one page, behind the same challenge",
    ),
    "headnotes-page": excludedSourceSurface(
      "the relation it presents is already stated in the listing payload",
    ),
    "decision-text-page": excludedSourceSurface(
      "a pointer to the document surface rather than a payload of its own",
    ),
    "headnote-chain": excludedSourceSurface(
      "derivable from an identifier the listing states, behind the same challenge",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
});
