import { panic } from "better-result";

import getSavedSearch from "@/api/handlers/saved-searches/get";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

/** Measure the same owner-filtered point read that reloads a stale editor. */
export const savedSearchReadScalingScenario = {
  name: "saved search editor reload",
  definition: getSavedSearch,
  measure: async (context: Parameters<typeof getSavedSearch.handler>[0]) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await getSavedSearch.handler(context);
      if (response instanceof HttpStatusResponse) {
        panic("Saved-search scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
        id: response.id,
      };
    }),
};
