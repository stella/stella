import readChatMcpAppBundle from "@/api/handlers/chat/mcp-apps/read-bundle";
import type { ResponseSet } from "@/api/http/context";
import { toSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

/**
 * A chat app's document is the server's own bundle: the read touches no
 * database, so nothing a member stores can grow it. The measured answer is
 * the bundle itself, the same for every member and every thread.
 */
export const chatMcpAppBundleScalingScenario = {
  name: "chat mcp app bundle",
  definition: readChatMcpAppBundle,
  measure: async ({ app }: { app: string }) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const set: ResponseSet = { headers: {} };
      const answer = await readChatMcpAppBundle.handler(
        createTestHandlerContext<
          Parameters<typeof readChatMcpAppBundle.handler>[0]
        >({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          safeDb: NO_DB,
          params: { app },
          session: {
            activeOrganizationId: toSafeId<"organization">("org_scaling"),
          },
          user: { id: toSafeId<"user">("user_scaling") },
          request: new Request("https://example.test/bundle"),
          set,
        }),
      );
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(answer)),
        rows: 1,
      };
    }),
};
