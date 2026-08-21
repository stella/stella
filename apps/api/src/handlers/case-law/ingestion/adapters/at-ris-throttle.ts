import { panic } from "better-result";

import {
  createPublisherRequestSlot,
  type PublisherRequestGateDependencies,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const REQUEST_INTERVAL_MS = 5000;
const RIS_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://data.bka.gv.at", "https://www.ris.bka.gv.at"],
} as const;
const RIS_PATH_PREFIXES = ["/ris/api/v2.6/Judikatur", "/Dokumente/"] as const;

export const createAtRisRequestSlot = (
  dependencies: PublisherRequestGateDependencies,
): ((signal?: AbortSignal) => Promise<void>) =>
  createPublisherRequestSlot(
    {
      intervalMs: REQUEST_INTERVAL_MS,
      key: "case-law:publisher-gate:ris-bka",
      publisher: "RIS",
    },
    dependencies,
  );

export const reserveAtRisRequestSlot = createPublisherRequestSlot({
  intervalMs: REQUEST_INTERVAL_MS,
  key: "case-law:publisher-gate:ris-bka",
  publisher: "RIS",
});

export const fetchAtRisWithRetry: typeof fetchWithRetry = async (
  url,
  init,
  options,
) => {
  const requestOptions = options ?? {};
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
    {
      ...requestOptions,
      beforeAttempt: async () =>
        await reserveAtRisRequestSlot(requestOptions.signal),
    },
  );
};
