import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import readChatQueue from "@/api/handlers/chat/queue/read";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type ChatQueueFixture = {
  database: GatedTestDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The personal chat whose queue is read. */
  threadId: SafeId<"chatThread">;
};

/**
 * One chat's queue: the chat by key and its queued messages, at most the
 * queue's limit, the same work however many other chats of the member have
 * messages waiting.
 */
export const chatQueueReadScalingScenario = {
  name: "chat queue read",
  definition: readChatQueue,
  measure: async ({
    database,
    organizationId,
    userId,
    threadId,
  }: ChatQueueFixture) => {
    const safeDb: SafeDb = async (work) =>
      await Result.tryPromise(async () => await database.transaction(work));
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readChatQueue.handler(
        asTestRaw<Parameters<typeof readChatQueue.handler>[0]>({
          getWorkspaceAccess: () =>
            panic("A personal chat's queue reads no matter"),
          params: { threadId },
          request: new Request(
            `https://example.test/v1/chat/threads/${threadId}/queue`,
          ),
          route: "/v1/chat/threads/:threadId/queue",
          safeDb,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        !("items" in response) ||
        response.items.length === 0
      ) {
        return panic("Chat queue scaling requires a queued message");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.items.length,
      };
    });
  },
};
