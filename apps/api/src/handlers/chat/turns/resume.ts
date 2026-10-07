import { toServerSentEventsResponse } from "@tanstack/ai";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { ChatTurnResumeProbe } from "@stll/chat/resume-contract";

import {
  chatMessages,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createChatRunLogReplay } from "@/api/lib/chat/run-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withSseHeartbeat } from "@/api/lib/sse";

const config = {
  description:
    "Rejoin a running turn in your chat thread, or load its stored transcript when the turn or its delivery log has ended.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "realtime_stream" },
  params: t.Object({
    threadId: tSafeId("chatThread"),
    turnId: tSafeId("chatTurn"),
  }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
    runId: t.Optional(t.String({ maxLength: 128 })),
    lastEventId: t.Optional(
      t.String({ maxLength: 19, pattern: "^(-1|now|[1-9][0-9]{0,18})$" }),
    ),
  }),
} satisfies HandlerConfig;

const createResumeHandler = (delivery: "probe" | "stream") =>
  createSafeRootHandler(
    config,
    async function* ({
      getWorkspaceAccess,
      params: { threadId, turnId },
      query: { workspaceId, lastEventId, runId },
      request,
      safeDb,
      scopedDb,
      session,
      user,
    }) {
      const scope = yield* resolveChatScope({
        getWorkspaceAccess,
        workspaceId,
      });
      const record = yield* Result.await(
        safeDb(async (tx) => {
          const [storedTurn] = await tx
            .select({
              workspaceId: chatThreads.workspaceId,
              runId: chatTurns.runId,
              status: chatTurns.status,
              closedAt: chatRunLogs.closedAt,
              messageId: chatMessages.id,
              messageContent: chatMessages.content,
              messageRole: chatMessages.role,
            })
            .from(chatTurns)
            .innerJoin(
              chatThreads,
              and(
                eq(chatThreads.id, chatTurns.threadId),
                eq(chatThreads.organizationId, session.activeOrganizationId),
                eq(chatThreads.userId, user.id),
              ),
            )
            .leftJoin(
              chatMessages,
              and(
                eq(chatMessages.id, chatTurns.assistantMessageId),
                eq(chatMessages.threadId, threadId),
              ),
            )
            .leftJoin(
              chatRunLogs,
              and(
                eq(chatRunLogs.organizationId, session.activeOrganizationId),
                eq(chatRunLogs.runId, chatTurns.runId),
              ),
            )
            .where(
              and(
                eq(chatTurns.id, turnId),
                eq(chatTurns.threadId, threadId),
                eq(chatTurns.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1);
          return storedTurn;
        }),
      );
      if (record === undefined) {
        return Result.err(
          new HandlerError({ status: 404, message: "Chat turn not found" }),
        );
      }
      yield* assertChatThreadScopeMatches({
        persistedWorkspaceId: record.workspaceId,
        scope,
      });
      if (
        record.status === "accepted" ||
        (record.status === "running" && record.runId === null)
      ) {
        return Result.ok({
          type: "preparing",
          turnId,
        } as const satisfies ChatTurnResumeProbe);
      }
      const resumeSnapshot =
        record.status === "awaiting-user" &&
        record.messageId !== null &&
        record.messageContent !== null &&
        record.messageRole !== null
          ? chatMessageFromPersisted({
              id: record.messageId,
              content: record.messageContent,
              role: record.messageRole,
            }).metadata?.resumeSnapshot
          : undefined;
      if (
        record.status !== "running" ||
        record.runId === null ||
        record.closedAt !== null ||
        (runId !== undefined && runId !== record.runId)
      ) {
        return Result.ok({
          type: "transcript",
          turnId,
          ...(resumeSnapshot === undefined ? {} : { resumeSnapshot }),
        } as const satisfies ChatTurnResumeProbe);
      }
      if (delivery === "probe") {
        return Result.ok({
          type: "running" as const,
          turnId,
          runId: record.runId,
        } as const satisfies ChatTurnResumeProbe);
      }
      const runningRunId = record.runId;
      const resumeOffset =
        request.headers.get("Last-Event-ID") ?? lastEventId ?? "-1";
      if (!/^(-1|now|[1-9][0-9]{0,18})$/u.test(resumeOffset)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Invalid chat run log offset",
          }),
        );
      }
      const replay = yield* Result.await(
        Result.tryPromise(
          async () =>
            await createChatRunLogReplay({
              db: scopedDb,
              organizationId: session.activeOrganizationId,
              runId: runningRunId,
              resumeOffset,
              waitForStart: true,
            }),
        ),
      );
      if (replay === null) {
        return Result.ok({
          type: "transcript",
          turnId,
        } as const satisfies ChatTurnResumeProbe);
      }
      const source = (async function* () {
        // Rejoin reads the existing durable producer; this viewer emits nothing.
      })();
      return Result.ok(
        withSseHeartbeat(
          toServerSentEventsResponse(source, {
            durability: { adapter: replay },
            abortController: new AbortController(),
          }),
        ),
      );
    },
  );

export const probeChatTurn = createResumeHandler("probe");
export const joinChatTurn = createResumeHandler("stream");
