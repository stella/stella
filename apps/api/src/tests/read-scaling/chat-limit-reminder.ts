import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import getChatLimitReminder from "@/api/handlers/chat/limit-reminder/get";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type ChatLimitReminderFixture = {
  database: GatedTestDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The personal chat whose reminder is read. */
  threadId: SafeId<"chatThread">;
};

/**
 * One chat's reminder: the chat and its reminder by key, the same work
 * however many other chats of the member wait on a reminder of their own.
 */
export const chatLimitReminderScalingScenario = {
  name: "chat limit reminder",
  definition: getChatLimitReminder,
  measure: async ({
    database,
    organizationId,
    userId,
    threadId,
  }: ChatLimitReminderFixture) => {
    const safeDb: SafeDb = async (work) =>
      await Result.tryPromise(async () => await database.transaction(work));
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await getChatLimitReminder.handler(
        asTestRaw<Parameters<typeof getChatLimitReminder.handler>[0]>({
          getWorkspaceAccess: () =>
            panic("A personal chat's reminder reads no matter"),
          params: { threadId },
          query: {},
          request: new Request(
            `https://example.test/v1/chat/threads/${threadId}/limit-reminder`,
          ),
          route: "/v1/chat/threads/:threadId/limit-reminder",
          safeDb,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        !("remindAt" in response) ||
        response.remindAt === null
      ) {
        return panic("Chat limit reminder scaling requires a stored reminder");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    });
  },
};
