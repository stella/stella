import { Result } from "better-result";
import { t } from "elysia";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  decodeMessagePageCursor,
  loadChatMessagePage,
} from "@/api/handlers/chat/message-page";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["create"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    before: t.String(),
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const getOlderMessages = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    params: { threadId },
    query: { before, workspaceId },
    safeDb,
    user,
  }) {
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
      workspaceId,
    });

    // Reproduce get-messages' ownership + scope checks before reading any
    // messages: the thread must belong to the caller, and the persisted
    // scope must match the requested one. Skipping this would let a caller
    // page another user's (or another scope's) messages by id (IDOR).
    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: user.id },
          },
          columns: { workspaceId: true },
        }),
      ),
    );

    if (!thread) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    const persistedWorkspaceId = thread.workspaceId ?? null;
    const requestedWorkspaceId =
      scope.scope === "workspace" ? scope.workspaceId : null;
    if (persistedWorkspaceId !== requestedWorkspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    const cursor = decodeMessagePageCursor(before);
    if (!cursor) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid pagination cursor",
        }),
      );
    }

    const page = yield* Result.await(
      loadChatMessagePage({
        safeDb,
        threadId,
        userId: user.id,
        before: cursor,
      }),
    );

    return Result.ok({
      messages: page.messages,
      olderCursor: page.olderCursor,
    });
  },
);

export default getOlderMessages;
