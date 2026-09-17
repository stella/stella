import { panic } from "better-result";

import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

/**
 * Every RIS request, pinned to the publisher's own origins and paths.
 *
 * The pacing is not here: `publisher-policy.ts` states what a RIS request
 * costs and `fetchWithRetry` reserves it. What this module still owns is
 * rule 21 — a `sourceUrl` replayed from storage reaches this function, and
 * nothing it carries may decide where the request goes.
 */
const RIS_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://data.bka.gv.at", "https://www.ris.bka.gv.at"],
} as const;
const RIS_PATH_PREFIXES = ["/ris/api/v2.6/Judikatur", "/Dokumente/"] as const;

export const fetchAtRisWithRetry: typeof fetchWithRetry = async (
  url,
  init,
  options,
) => {
  const target = restrictOutboundUrl({
    hostPolicy: RIS_HOST_POLICY,
    pathPrefixes: RIS_PATH_PREFIXES,
    rawUrl: url,
  });
  if (target === null) {
    return panic("RIS request escaped the publisher origin or path");
  }
  return await fetchWithRetry(
    target.toString(),
    { ...init, redirect: "error" },
    options,
  );
};
