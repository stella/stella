import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  // `chat` has no dedicated read verb yet (see packages/permissions); the
  // sibling read endpoints (get-messages, get-threads) gate on `create`, so
  // this by-id title read follows the same convention.
  permissions: { chat: ["create"] },
  mcp: { type: "pending" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

// Returns just a chat thread's title, scoped to the caller's org/user/
// workspace. Kept as its own slice so shared chrome (the breadcrumb) can read
// a single thread's title by id without paging the grouped-threads list; a
// missing thread is a 404, never an empty title.
const getThreadTitle = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
      workspaceId,
    });

    const [existing] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ title: chatThreads.title })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.organizationId, session.activeOrganizationId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .limit(1),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    return Result.ok({ title: existing.title });
  },
);

export default getThreadTitle;
