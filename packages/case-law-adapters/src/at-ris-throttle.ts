// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: pure helper and publisher-gate hook imports moved to @stll/case-law-ingestion-core; parser output unchanged.
// parser-output-unchanged: typed publisher read wrapper preserves the RIS origin/path policy and served response text.
import { panic } from "better-result";

import type { ReadOutcome } from "@stll/case-law-ingestion-core/read-outcome";
import { restrictOutboundUrl } from "@stll/case-law-ingestion-core/restrict-outbound-url";

import { type PublisherReadInit, readPublisherText } from "./publisher-read";

/**
 * Every RIS request, pinned to the publisher's own origins and paths.
 *
 * The pacing is not here: `publisher-policy.ts` states what a RIS request
 * costs and `fetchPublisher` reserves it. What this module still owns is
 * rule 21 — a `sourceUrl` replayed from storage reaches this function, and
 * nothing it carries may decide where the request goes.
 */
/**
 * The origins this publisher serves a decision's documents from.
 *
 * Two, because the listing is what states which one a document is at: the
 * open-data host answers every document today, the citizen host answered them
 * before, and an adapter that reconstructs the address instead of following
 * the listed one stops fetching documents the day the publisher moves them.
 * The address the crawl uses is checked against this list and against the
 * path the document number implies, so a listed URL still cannot send a
 * request anywhere else.
 */
export const AT_RIS_DOCUMENT_ORIGINS = [
  "https://ogd.ris.bka.gv.at",
  "https://www.ris.bka.gv.at",
] as const;

const RIS_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://data.bka.gv.at", ...AT_RIS_DOCUMENT_ORIGINS],
} as const;
const RIS_PATH_PREFIXES = ["/ris/api/v2.6/Judikatur", "/Dokumente/"] as const;

export type AtRisReadText = (
  url: string,
  init: PublisherReadInit,
) => Promise<ReadOutcome<string>>;

export const readAtRisText: AtRisReadText = async (url, init) => {
  const target = restrictOutboundUrl({
    hostPolicy: RIS_HOST_POLICY,
    pathPrefixes: RIS_PATH_PREFIXES,
    rawUrl: url,
  });
  if (target === null) {
    return panic("RIS request escaped the publisher origin or path");
  }
  return await readPublisherText(target, { ...init, redirect: "error" });
};
