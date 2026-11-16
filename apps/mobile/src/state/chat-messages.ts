import { Result } from "better-result";
import * as v from "valibot";

import type { AIErrorKind } from "@stll/api-contract/ai-errors";
import {
  CHAT_CONTEXT_NOTICE_METADATA_KEY,
  chatContextNoticeSchema,
} from "@stll/api-contract/chat-context-notice";
import type { ChatContextNotice } from "@stll/api-contract/chat-context-notice";
import {
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { answerBlocks, messageText } from "@/state/chat-answer";
import type { AnswerBlock } from "@/state/chat-answer";
import type { ChatDraft, SentFile } from "@/state/chat-attachments";
import { draftDocumentsOf } from "@/state/chat-documents";
import type { ChatDraftDocument } from "@/state/chat-documents";
import { storedTurnFailure } from "@/state/chat-failure";
import { localRunTargetOf, pendingInputOf } from "@/state/chat-pending-input";
import type { LocalRunTarget, PendingInput } from "@/state/chat-pending-input";

/**
 * A stored message part. Text, reasoning, tool calls and attached files are
 * drawn (`./chat-answer.ts`); every other kind passes the schema and is
 * skipped, so a part this build has never seen does not fail the thread.
 */
const partSchema = v.looseObject({
  type: v.string(),
  content: v.optional(v.unknown()),
  name: v.optional(v.unknown()),
  source: v.optional(v.unknown()),
  metadata: v.optional(v.unknown()),
});

/** An attached file's part: an image or a document, with the file's name and type. */
const filePartSchema = v.object({
  type: v.picklist(["image", "document"]),
  source: v.looseObject({ mimeType: v.optional(v.string()) }),
  metadata: v.optional(v.looseObject({ filename: v.optional(v.string()) })),
});

const messageSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  role: v.string(),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  parts: v.array(partSchema),
  /**
   * Read for whether the message's turn waits for the person or failed, and
   * for the answer's context notice.
   */
  metadata: v.optional(v.unknown()),
});

const messagesPageSchema = v.object({
  messages: v.array(messageSchema),
  olderCursor: v.nullable(v.string()),
  activeTurnId: v.optional(v.nullable(v.string()), null),
  usedAnonymization: v.optional(v.boolean(), false),
  /** Where the thread's turns run, read where a paused one is answered. */
  runTarget: v.optional(v.unknown()),
});

/**
 * A message as the thread shows it: its text, an answer's texts and the
 * steps between them in order, the files the person attached, and the
 * drafts the assistant wrote.
 */
export type ChatEntry = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  /** The message's text, as copying it gives it. */
  readonly text: string;
  /** An answer as it is drawn; a person's own message draws its `text`. */
  readonly blocks: readonly AnswerBlock[];
  readonly files: readonly SentFile[];
  readonly drafts: readonly ChatDraftDocument[];
  /** Why the answer's turn failed; absent for one that did not. */
  readonly failure?: AIErrorKind;
  /** What the answer's context left out, as the web says it too. */
  readonly contextNotice: ChatContextNotice | null;
};

const contextNoticeMetadataSchema = v.object({
  [CHAT_CONTEXT_NOTICE_METADATA_KEY]: v.nullable(chatContextNoticeSchema),
});

/**
 * The context notice a stored message's or a stream event's metadata states:
 * the notice, `null` where the stream withdraws one an earlier attempt
 * streamed, or undefined where it says nothing of one. A notice this build
 * does not know says nothing, so it does not fail the thread.
 */
export const contextNoticeIn = (
  metadata: unknown,
): ChatContextNotice | null | undefined => {
  const parsed = v.safeParse(contextNoticeMetadataSchema, metadata);
  return parsed.success
    ? parsed.output[CHAT_CONTEXT_NOTICE_METADATA_KEY]
    : undefined;
};

/**
 * What answers the thread's latest message again once its answer failed:
 * that message as the thread stores it, and the computer target the thread's
 * turns run on, if they run on the person's computer.
 */
export type ChatRetry = {
  /** The answer that failed, which the new one replaces. */
  readonly answerId: string;
  readonly messageId: string;
  readonly parts: readonly unknown[];
  readonly runTarget: LocalRunTarget | undefined;
};

/**
 * Messages oldest first, the cursor for the page before them (null at the
 * thread's start), the turn still answering, if one is, whether the thread
 * has sent anonymized text, which every later message must keep to, and, on
 * the thread's latest page, what its paused turn waits for.
 */
export type ChatMessagesPage = {
  readonly entries: readonly ChatEntry[];
  readonly olderCursor: string | null;
  readonly activeTurnId: string | null;
  readonly usedAnonymization: boolean;
  readonly pendingInput: PendingInput | null;
  /** On the thread's latest page, when its latest answer failed. */
  readonly retry: ChatRetry | null;
  /** Where the thread's turns run: on stella's model path, or a computer. */
  readonly runTargetKind: ChatRunTarget["kind"];
};

type StoredMessage = v.InferOutput<typeof messageSchema>;

/**
 * What a phone can show of one stored message. System messages and messages
 * with nothing to draw are left out; a failed answer always draws, as the
 * reason it failed.
 */
export const toChatEntry = (message: StoredMessage): ChatEntry | undefined => {
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  const text = messageText(message.parts);
  const blocks =
    message.role === "assistant" ? answerBlocks(message.parts) : [];
  const files = message.parts.flatMap((part): SentFile[] => {
    const file = v.safeParse(filePartSchema, part);
    return file.success
      ? [
          {
            name: file.output.metadata?.filename ?? "",
            mimeType: file.output.source.mimeType ?? "",
          },
        ]
      : [];
  });
  const drafts = draftDocumentsOf(message.parts);
  const failure =
    message.role === "assistant"
      ? storedTurnFailure(message.metadata)
      : undefined;
  if (
    text === "" &&
    blocks.length === 0 &&
    files.length === 0 &&
    drafts.length === 0 &&
    failure === undefined
  ) {
    return undefined;
  }
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    text,
    blocks,
    files,
    drafts,
    contextNotice:
      message.role === "assistant"
        ? (contextNoticeIn(message.metadata) ?? null)
        : null,
    ...(failure === undefined ? {} : { failure }),
  };
};

/**
 * The retry a page offers: only when its last message is an answer that
 * failed, for the person's message it answered, which is then the thread's
 * latest.
 */
const retryOf = (
  messages: readonly StoredMessage[],
  runTarget: unknown,
): ChatRetry | null => {
  const last = messages.at(-1);
  if (
    last?.role !== "assistant" ||
    storedTurnFailure(last.metadata) === undefined
  ) {
    return null;
  }
  const asked = messages.findLast(({ role }) => role === "user");
  return asked === undefined
    ? null
    : {
        answerId: last.id,
        messageId: asked.id,
        parts: asked.parts,
        runTarget: localRunTargetOf(runTarget),
      };
};

/** A message this phone sends, as the thread shows it until the stored one replaces it. */
export const sentEntry = ({
  createdAt,
  draft: { files, text },
  messageId,
}: {
  readonly createdAt: string;
  readonly draft: ChatDraft;
  readonly messageId: string;
}): ChatEntry => ({
  id: messageId,
  role: "user",
  createdAt,
  text,
  blocks: [],
  // The thread names each file; its bytes have gone with the message.
  files: files.map(({ mimeType, name }) => ({ mimeType, name })),
  drafts: [],
  contextNotice: null,
});

/**
 * A page as the thread shows it. Only the latest page can end on a turn
 * that waits. A waiting turn is still the thread's active one, so the page
 * names it in `activeTurnId` as well.
 */
const toPage = (
  page: v.InferOutput<typeof messagesPageSchema>,
  { latest }: { readonly latest: boolean },
): ChatMessagesPage => ({
  entries: page.messages.flatMap((message) => toChatEntry(message) ?? []),
  olderCursor: page.olderCursor,
  activeTurnId: page.activeTurnId,
  usedAnonymization: page.usedAnonymization,
  // A thread that never chose where it runs runs on stella's model path.
  runTargetKind: v.is(chatRunTargetSchema, page.runTarget)
    ? page.runTarget.kind
    : CHAT_RUN_TARGET_KIND.cloud,
  pendingInput: latest
    ? pendingInputOf({
        message: page.messages.at(-1),
        runTarget: page.runTarget,
      })
    : null,
  retry: latest ? retryOf(page.messages, page.runTarget) : null,
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

/**
 * The query of a messages read: the page to continue from, and the thread's
 * matter, without which the server refuses a matter's thread as out of scope.
 */
export const messagesQuery = ({
  before,
  matterId,
}: {
  readonly before?: string | undefined;
  readonly matterId: string | undefined;
}): string => {
  const params = [
    ...(before === undefined ? [] : [`before=${encodeURIComponent(before)}`]),
    ...(matterId === undefined
      ? []
      : [`workspaceId=${encodeURIComponent(matterId)}`]),
  ];
  return params.length === 0 ? "" : `?${params.join("&")}`;
};

/** A thread's latest messages. */
export const readChatThread = async ({
  fetch,
  matterId,
  source,
  threadId,
}: {
  readonly fetch: Fetch;
  readonly matterId: string | undefined;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<Result<ChatMessagesPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${threadPath(threadId)}${messagesQuery({ matterId })}`,
        schema: messagesPageSchema,
        source,
      }),
    );
    return Result.ok(toPage(page, { latest: true }));
  });

/** The page of messages before `before`, the cursor a previous read returned. */
export const readOlderChatMessages = async ({
  before,
  fetch,
  matterId,
  source,
  threadId,
}: {
  readonly before: string;
  readonly fetch: Fetch;
  readonly matterId: string | undefined;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<Result<ChatMessagesPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${threadPath(threadId)}/older${messagesQuery({ before, matterId })}`,
        schema: messagesPageSchema,
        source,
      }),
    );
    return Result.ok(toPage(page, { latest: false }));
  });
