import readOutlookClientMetadata from "@/api/handlers/mcp-connectors/read-outlook-client-metadata";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The Outlook client metadata document is built from configuration alone, so
 * a read costs no statements however much data the deployment holds.
 */
export const outlookClientMetadataScalingScenario = {
  name: "Outlook client metadata document",
  definition: readOutlookClientMetadata,
  measure: async () =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readOutlookClientMetadata.handler(
        asTestRaw<Parameters<typeof readOutlookClientMetadata.handler>[0]>({
          request: new Request(
            "https://example.test/v1/mcp/oauth/outlook-client-metadata.json",
          ),
          route: "/v1/mcp/oauth/outlook-client-metadata.json",
          set: { headers: {} },
        }),
      );
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
