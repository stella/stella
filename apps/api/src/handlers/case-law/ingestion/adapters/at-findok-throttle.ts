import { panic } from "better-result";

import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  type PublisherReadInit,
  readPublisher,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import type { ReadOutcome } from "@/api/lib/errors/read-outcome";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

/**
 * Every Findok request, pinned to the publisher's own origin and path.
 *
 * The pacing is not here: `publisher-policy.ts` states what a Findok request
 * costs and `readPublisher` reserves it. What this module still owns is
 * rule 21 — the outbound allowlist an archived URL cannot talk its way past.
 */
export const FINDOK_REQUEST_INTERVAL_MS = publisherRequestIntervalMs(
  ADAPTER_KEYS.AT_FINDOK,
);
const FINDOK_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://findok.bmf.gv.at"],
} as const;
const FINDOK_PATH_PREFIXES = ["/findok/iwg/"] as const;

export const readAtFindok = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<Response>> => {
  const target = restrictOutboundUrl({
    hostPolicy: FINDOK_HOST_POLICY,
    pathPrefixes: FINDOK_PATH_PREFIXES,
    rawUrl: url instanceof URL ? url.toString() : url,
  });
  if (target === null) {
    return panic("Findok request escaped the publisher origin or path");
  }
  return await readPublisher(target.toString(), {
    ...init,
    redirect: "error",
  });
};
