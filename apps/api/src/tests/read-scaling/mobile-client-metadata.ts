import readMobileClientMetadata from "@/api/handlers/mcp-connectors/read-mobile-client-metadata";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The mobile client metadata document is built from configuration alone, so
 * a read costs no statements however much data the deployment holds.
 */
export const mobileClientMetadataScalingScenario = {
  name: "mobile client metadata document",
  definition: readMobileClientMetadata,
  measure: async () =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readMobileClientMetadata.handler(
        asTestRaw<Parameters<typeof readMobileClientMetadata.handler>[0]>({
          request: new Request(
            "https://example.test/v1/mcp/oauth/mobile-client-metadata.json",
          ),
          route: "/v1/mcp/oauth/mobile-client-metadata.json",
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
