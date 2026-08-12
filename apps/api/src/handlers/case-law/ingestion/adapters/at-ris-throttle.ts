import {
  createPublisherRequestSlot,
  type PublisherRequestGateDependencies,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import { fetchWithRetry } from "@/api/handlers/case-law/ingestion/adapters/retry";

const REQUEST_INTERVAL_MS = 5000;

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
  options = {},
) =>
  await fetchWithRetry(url, init, {
    ...options,
    beforeAttempt: async () => await reserveAtRisRequestSlot(options.signal),
  });
