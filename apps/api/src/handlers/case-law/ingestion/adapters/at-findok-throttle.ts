import { panic } from "better-result";

import { createPublisherRequestSlot } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

export const FINDOK_REQUEST_INTERVAL_MS = 1500;
const FINDOK_HOST_POLICY = {
  type: "exact-origin",
  origins: ["https://findok.bmf.gv.at"],
} as const;
const FINDOK_PATH_PREFIXES = ["/findok/iwg/"] as const;

const reserveAtFindokRequestSlot = createPublisherRequestSlot({
  intervalMs: FINDOK_REQUEST_INTERVAL_MS,
  key: "case-law:publisher-gate:findok-bmf",
  publisher: "Findok",
});

export const fetchAtFindokWithRetry: typeof fetchWithRetry = async (
  url,
  init,
  options,
) => {
  const requestOptions = options ?? {};
  const target = restrictOutboundUrl({
    hostPolicy: FINDOK_HOST_POLICY,
    pathPrefixes: FINDOK_PATH_PREFIXES,
    rawUrl: url,
  });
  if (target === null) {
    return panic("Findok request escaped the publisher origin or path");
  }
  return await fetchWithRetry(
    target.toString(),
    { ...init, redirect: "error" },
    {
      ...requestOptions,
      beforeAttempt: async () =>
        await reserveAtFindokRequestSlot(requestOptions.signal),
    },
  );
};
