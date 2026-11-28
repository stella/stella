// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: pure helper and publisher-gate hook imports moved to @stll/case-law-ingestion-core; parser output unchanged.
// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
// parser-output-unchanged: [at-findok] migrated throttle wrapper to readPublisher; served response parsing is unchanged.
import { panic } from "better-result";

import { publisherRequestIntervalMs } from "@stll/case-law-adapters/publisher-policy";
import {
  type PublisherReadInit,
  readPublisher,
} from "@stll/case-law-adapters/publisher-read";
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/ingestion-constants";
import { restrictOutboundUrl } from "@stll/case-law-ingestion-core/restrict-outbound-url";

import type { ReadOutcome } from "@/api/lib/errors/read-outcome";

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
    refusalScope:
      init.refusalScope ??
      (init.fetchStage === "listing" ? "source" : "document"),
    redirect: "error",
  });
};
