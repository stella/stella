import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { fetchServerSentEvents } from "@tanstack/ai-client";
import type { UIMessage } from "@tanstack/ai-client";
import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import type { ClientMessage } from "@/api/handlers/chat/message-page";
import type { SafeId } from "@/api/lib/branded-types";
import type { DeliveredInterrupt } from "@/api/tests/helpers/chat-live-reload-invariants";
import { loadWebChat } from "@/api/tests/helpers/chat-web-client";
import { asFetchMock, asTestRaw } from "@/api/tests/helpers/test-tool-set";

// What the browser reads and what it holds. A response is read with the
// client package's own SSE connection adapter, and a reload is the page load
// the web app runs: the messages endpoint's page, carried over JSON, read
// back the way the web app deserializes it, then passed through the web app's
// own `sanitizeRunningToolCalls` before it seeds the runtime.

/**
 * The chunks the browser reads from a chat response, parsed by the client's
 * own SSE connection adapter. The response is consumed.
 */
export const readClientStreamChunks = async ({
  response,
  runId,
  threadId,
}: {
  response: Response;
  runId: string;
  threadId: string;
}): Promise<StreamChunk[]> => {
  let served = false;
  const connection = fetchServerSentEvents("http://localhost/v1/chat/send", {
    fetchClient: asFetchMock(async () => {
      if (served) {
        return panic("The client reconnected to a finished chat response");
      }
      served = true;
      return await Promise.resolve(response);
    }),
  });
  const chunks: StreamChunk[] = [];
  for await (const chunk of connection.connect([], {}, undefined, {
    runId,
    threadId,
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

const bindingToolCallId = (metadata: unknown): string | null => {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const binding: unknown = Reflect.get(metadata, "tanstack:interruptBinding");
  if (typeof binding !== "object" || binding === null) {
    return null;
  }
  const toolCallId: unknown = Reflect.get(binding, "toolCallId");
  return typeof toolCallId === "string" ? toolCallId : null;
};

/**
 * The interrupts a response hands the page, which its runtime hydrates and
 * its cards resolve: those of the response's last interrupted run, or none
 * when the response finished without one.
 */
export const deliveredInterrupts = (
  chunks: readonly StreamChunk[],
): DeliveredInterrupt[] => {
  const finished = chunks.findLast(
    (chunk) => chunk.type === EventType.RUN_FINISHED,
  );
  if (
    finished?.type !== EventType.RUN_FINISHED ||
    finished.outcome?.type !== "interrupt"
  ) {
    return [];
  }
  // An interrupt without a tool binding stays in the list under no call, so
  // no card can match it and the actionable check reports the card.
  return finished.outcome.interrupts.map((interrupt) => ({
    interruptId: interrupt.id,
    toolCallId: bindingToolCallId(interrupt.metadata),
  }));
};

/**
 * The message list a freshly loaded page holds: the thread's first page as
 * the messages endpoint serves it (`loadChatMessagePage`, with placeholders
 * and paging), carried over JSON, read back with dates the way the web app's
 * `deserializeChatMessages` does, and sanitized by the web app's own
 * `sanitizeRunningToolCalls(..., "hydrate")`.
 */
export const loadReloadView = async ({
  safeDb,
  threadId,
  userId,
}: {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
}): Promise<UIMessage[]> => {
  const page = await loadChatMessagePage({ safeDb, threadId, userId });
  if (Result.isError(page)) {
    return panic("The thread's message page failed to load", page.error);
  }
  // The page as the browser receives it: a JSON body.
  const served = asTestRaw<ClientMessage[]>(
    await Response.json(page.value.messages).json(),
  );
  const deserialized = asTestRaw<UIMessage[]>(
    served.map((message) =>
      Object.assign(message, {
        createdAt: new Date(message.createdAt),
        parts: message.parts.map((part) =>
          part.type === "tool-result" && part.createdAt !== undefined
            ? Object.assign(part, { createdAt: new Date(part.createdAt) })
            : part,
        ),
      }),
    ),
  );
  const web = await loadWebChat();
  return web.sanitizeRunningToolCalls(deserialized, "hydrate");
};
