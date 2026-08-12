import { createPublisherRequestSlot } from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";

export const FINDOK_REQUEST_INTERVAL_MS = 1500;

const reserveAtFindokRequestSlot = createPublisherRequestSlot({
  intervalMs: FINDOK_REQUEST_INTERVAL_MS,
  key: "case-law:publisher-gate:findok-bmf",
  publisher: "Findok",
});

export const fetchAtFindokWithRetry: typeof fetchWithRetry = async (
  url,
  init,
  options = {},
) =>
  await fetchWithRetry(url, init, {
    ...options,
    beforeAttempt: async () => await reserveAtFindokRequestSlot(options.signal),
  });
