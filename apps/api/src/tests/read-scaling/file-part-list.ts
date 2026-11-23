import { panic } from "better-result";

import { readFilePartListEndpoint } from "@/api/handlers/files/part-list";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const filePartListScalingScenario = {
  name: "files inside a part of a file",
  definition: readFilePartListEndpoint,
  measure: async (
    context: Parameters<typeof readFilePartListEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readFilePartListEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected the files inside a part");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
