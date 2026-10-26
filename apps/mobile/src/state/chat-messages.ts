import { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/**
 * A stored message part. Only text and tool calls are drawn; every other
 * kind (reasoning, attachments, results) passes the schema and is skipped,
 * so a part this build has never seen does not fail the thread.
 */
const partSchema = v.looseObject({
  type: v.string(),
  content: v.optional(v.unknown()),
  name: v.optional(v.unknown()),
});

const messageSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  role: v.string(),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  parts: v.array(partSchema),
});

const messagesPageSchema = v.object({
  messages: v.array(messageSchema),
  olderCursor: v.nullable(v.string()),
  activeTurnId: v.optional(v.nullable(v.string()), null),
});

/** A message as the thread shows it: its text, and the tools the assistant used on the way. */
export type ChatEntry = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  readonly text: string;
  readonly tools: readonly string[];
};

/**
 * Messages oldest first, the cursor for the page before them (null at the
 * thread's start), and the turn still answering, if one is.
 */
export type ChatMessagesPage = {
  readonly entries: readonly ChatEntry[];
  readonly olderCursor: string | null;
  readonly activeTurnId: string | null;
};

type StoredMessage = v.InferOutput<typeof messageSchema>;

/**
 * What a phone can show of one stored message. System messages and messages
 * with nothing to draw are left out.
 */
export const toChatEntry = (message: StoredMessage): ChatEntry | undefined => {
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  const text = message.parts
    .flatMap((part) =>
      part.type === "text" && typeof part.content === "string"
        ? [part.content.trim()]
        : [],
    )
    .filter((content) => content !== "")
    .join("\n\n");
  const tools = message.parts.flatMap((part) =>
    part.type === "tool-call" && typeof part.name === "string"
      ? [part.name]
      : [],
  );
  if (text === "" && tools.length === 0) {
    return undefined;
  }
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    text,
    tools,
  };
};

const toPage = (
  page: v.InferOutput<typeof messagesPageSchema>,
): ChatMessagesPage => ({
  entries: page.messages.flatMap((message) => toChatEntry(message) ?? []),
  olderCursor: page.olderCursor,
  activeTurnId: page.activeTurnId,
});

/** An older page in front of what is loaded, without a message twice. */
export const prependOlderPage = (
  loaded: readonly ChatEntry[],
  older: readonly ChatEntry[],
): ChatEntry[] => {
  const seen = new Set(loaded.map((entry) => entry.id));
  return [...older.filter((entry) => !seen.has(entry.id)), ...loaded];
};

const threadPath = (threadId: string) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/messages`;

/** A thread's latest messages. */
export const readChatThread = async ({
  fetch,
  source,
  threadId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<Result<ChatMessagesPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: threadPath(threadId),
        schema: messagesPageSchema,
        source,
      }),
    );
    return Result.ok(toPage(page));
  });

/** The page of messages before `before`, the cursor a previous read returned. */
export const readOlderChatMessages = async ({
  before,
  fetch,
  source,
  threadId,
}: {
  readonly before: string;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<Result<ChatMessagesPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${threadPath(threadId)}/older?before=${encodeURIComponent(before)}`,
        schema: messagesPageSchema,
        source,
      }),
    );
    return Result.ok(toPage(page));
  });
