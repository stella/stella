import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { chatThreads } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import {
  generateThreadRecapText,
  isThreadStaleForRecap,
  RECAP_MIN_MESSAGE_COUNT,
  RECAP_PROMPT_VERSION,
} from "@/api/handlers/chat/thread-recap";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import { captureError } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { THREAD_STORED_CONTENT_SEND_MODE } from "@/api/lib/chat/thread-stored-content-send-mode";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

type CacheThreadRecapOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  compactionEpoch: number;
  lastMessageId: SafeId<"chatMessage">;
  recap: string;
};

/** An edit may settle while recap generation runs outside the transaction. */
export const cacheThreadRecapOnTx = async ({
  tx,
  threadId,
  userId,
  compactionEpoch,
  lastMessageId,
  recap,
}: CacheThreadRecapOptions) =>
  // audit: skip - derived recap cache maintenance; no user-authored state change
  await tx
    .update(chatThreads)
    .set({
      recapText: recap,
      recapMessageId: lastMessageId,
      recapPromptVersion: RECAP_PROMPT_VERSION,
      recapGeneratedAt: new Date(),
      updatedAt: sql`${chatThreads.updatedAt}`,
    })
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.userId, userId),
        eq(chatThreads.compactionEpoch, compactionEpoch),
      ),
    )
    .returning({ id: chatThreads.id });

const config = {
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ workspaceId: t.Optional(tSafeId("workspace")) }),
} satisfies HandlerConfig;

type ThreadRecapResult = { recap: string | null };

const getThreadRecap = createSafeRootHandler(config, async function* (ctx) {
  const {
    getWorkspaceAccess,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    params: { threadId },
    promptCachingEnabled,
    query: { workspaceId },
    safeDb,
    session,
    user,
  } = ctx;
  // The recap is a non-critical nicety: when AI is unavailable we
  // return no recap rather than blocking the thread view.
  if (
    Result.isError(
      requireTanStackAIAvailableForRole({
        dataClass: "customer",
        configStatus: orgAIConfigStatus,
        orgConfig: orgAIConfig,
        role: "fast",
      }),
    )
  ) {
    return Result.ok<ThreadRecapResult>({ recap: null });
  }

  const scope = yield* resolveChatScope({
    getWorkspaceAccess,
    workspaceId,
  });

  const thread = yield* Result.await(
    safeDb((tx) =>
      tx.query.chatThreads.findFirst({
        where: {
          id: { eq: threadId },
          userId: { eq: user.id },
        },
        columns: {
          compactionEpoch: true,
          workspaceId: true,
          recapText: true,
          recapMessageId: true,
          recapPromptVersion: true,
          usedAnonymization: true,
        },
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
  yield* assertChatThreadScopeMatches({ persistedWorkspaceId, scope });

  if (thread.usedAnonymization) {
    return Result.ok<ThreadRecapResult>({ recap: null });
  }

  const messageWindow = yield* Result.await(
    loadRecapMessageWindow({ safeDb, threadId, userId: user.id }),
  );
  if (messageWindow.sendMode === THREAD_STORED_CONTENT_SEND_MODE.anonymized) {
    return Result.ok<ThreadRecapResult>({ recap: null });
  }

  // Only recap a completed exchange the user is returning to after a
  // gap: the latest persisted turn must be an assistant message and
  // old enough to count as a revisit.
  const lastMessage = messageWindow.messages.at(-1);
  if (
    !lastMessage ||
    lastMessage.role !== "assistant" ||
    messageWindow.recentCount < RECAP_MIN_MESSAGE_COUNT ||
    !isThreadStaleForRecap(lastMessage.createdAt)
  ) {
    return Result.ok<ThreadRecapResult>({ recap: null });
  }

  const recapMessages = messageWindow.messages.map((row) => {
    const message = chatMessageFromPersisted(row);
    return {
      role: message.role,
      parts: message.parts,
    };
  });

  // Cache hit: the stored recap already covers this exact message
  // tail and prompt version, so no model call is needed.
  if (
    thread.recapText &&
    thread.recapMessageId === lastMessage.id &&
    thread.recapPromptVersion === RECAP_PROMPT_VERSION
  ) {
    return Result.ok<ThreadRecapResult>({ recap: thread.recapText });
  }

  // Only a cache miss spends a model call, so only a cache miss draws an
  // action; a refusal answers like any other admission refusal.
  const { recap } = yield* Result.await(
    Result.gen(() =>
      admitFiniteAction({
        actionKind: "chat.thread-recap",
        ctx,
        async *handler({ modelAdmission }) {
          const generated = yield* Result.await(
            generateThreadRecapText({
              admission: modelAdmission,
              messages: recapMessages,
              organizationId: session.activeOrganizationId,
              orgAIConfig,
              managedAIResidency,
              promptCachingEnabled,
              threadId,
              workspaceId: persistedWorkspaceId,
            }).then((text) => Result.ok(text)),
          );
          return Result.ok({ recap: generated });
        },
      }),
    ),
  );

  if (!recap) {
    // Deliberately not cached: a null means either an empty
    // transcript (no model call was spent) or a transient
    // generation failure we'd rather retry on the next revisit than
    // suppress. Successful recaps cache below, so a thread only ever
    // spends one model call per message tail in the common case.
    return Result.ok<ThreadRecapResult>({ recap: null });
  }

  // Cache best-effort: a write failure should not fail the read, so
  // the recap still reaches the user (it just regenerates next time).
  const persistResult = await safeDb(
    async (tx) =>
      await cacheThreadRecapOnTx({
        tx,
        threadId,
        userId: user.id,
        compactionEpoch: thread.compactionEpoch,
        lastMessageId: lastMessage.id,
        recap,
      }),
  );
  if (Result.isError(persistResult)) {
    captureError(persistResult.error, { threadId });
  }

  return Result.ok<ThreadRecapResult>({ recap });
});

export default getThreadRecap;
