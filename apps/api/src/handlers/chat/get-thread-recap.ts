import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  generateThreadRecapText,
  isThreadStaleForRecap,
  RECAP_MIN_MESSAGE_COUNT,
  RECAP_PROMPT_VERSION,
  threadUsedAnonymization,
} from "@/api/handlers/chat/thread-recap";
import { requireAIAvailable } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["create"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ workspaceId: t.Optional(tSafeId("workspace")) }),
} satisfies HandlerConfig;

type ThreadRecapResult = { recap: string | null };

const getThreadRecap = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    orgAIConfig,
    params: { threadId },
    promptCachingEnabled,
    query: { workspaceId },
    safeDb,
    session,
    user,
  }) {
    // The recap is a non-critical nicety: when AI is unavailable we
    // return no recap rather than blocking the thread view.
    if (Result.isError(requireAIAvailable(orgAIConfig))) {
      return Result.ok<ThreadRecapResult>({ recap: null });
    }

    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
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
            workspaceId: true,
            recapText: true,
            recapMessageId: true,
            recapPromptVersion: true,
          },
          with: {
            messages: {
              columns: {
                id: true,
                role: true,
                content: true,
                createdAt: true,
              },
              orderBy: { createdAt: "asc" },
            },
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

    // Reject a scope that contradicts the persisted thread, mirroring
    // get-messages: a workspace thread asked for as global (or vice
    // versa) is a client bug.
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

    // Only recap a completed exchange the user is returning to after a
    // gap: the latest persisted turn must be an assistant message and
    // old enough to count as a revisit.
    const lastMessage = thread.messages.at(-1);
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      thread.messages.length < RECAP_MIN_MESSAGE_COUNT ||
      !isThreadStaleForRecap(lastMessage.createdAt)
    ) {
      return Result.ok<ThreadRecapResult>({ recap: null });
    }

    const recapMessages = thread.messages.map((row) => ({
      role: row.role,
      parts: row.content.data,
    }));

    // Stored content holds originals; anonymized turns only ever sent
    // placeholders to the model. Building a recap from this content
    // and sending it to the model would bypass that boundary, so skip
    // the recap entirely for any thread that used anonymization.
    if (threadUsedAnonymization(recapMessages)) {
      return Result.ok<ThreadRecapResult>({ recap: null });
    }

    // Cache hit: the stored recap already covers this exact message
    // tail and prompt version, so no model call is needed.
    if (
      thread.recapText &&
      thread.recapMessageId === lastMessage.id &&
      thread.recapPromptVersion === RECAP_PROMPT_VERSION
    ) {
      return Result.ok<ThreadRecapResult>({ recap: thread.recapText });
    }

    const recap = await generateThreadRecapText({
      messages: recapMessages,
      organizationId: session.activeOrganizationId,
      orgAIConfig,
      promptCachingEnabled,
      threadId,
      workspaceId: persistedWorkspaceId,
    });

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
    const persistResult = await safeDb((tx) =>
      tx
        .update(chatThreads)
        .set({
          recapText: recap,
          recapMessageId: lastMessage.id,
          recapPromptVersion: RECAP_PROMPT_VERSION,
          recapGeneratedAt: new Date(),
        })
        .where(
          and(eq(chatThreads.id, threadId), eq(chatThreads.userId, user.id)),
        ),
    );
    if (Result.isError(persistResult)) {
      captureError(persistResult.error, { threadId });
    }

    return Result.ok<ThreadRecapResult>({ recap });
  },
);

export default getThreadRecap;
