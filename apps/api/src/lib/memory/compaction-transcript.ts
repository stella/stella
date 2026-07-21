/**
 * Renders the message range a compaction summarized back into a bounded,
 * untrusted transcript for memory extraction.
 *
 * The extractor originally mined `chatThreadCompactions.summaryMarkdown`
 * alone. That summary is written for conversational continuity, not durable
 * recall: a drafting preference stated once is exactly the kind of detail a
 * summarizer drops, so it could never reach memory. Compaction is a
 * checkpoint and not a delete, so the original `chat_messages` rows are still
 * there; reading the summarized range recovers that lost signal while the
 * summary continues to supply the thread-level narrative.
 *
 * Everything here is untrusted tenant content. It is escaped for the trust
 * delimiter and hard-capped before it reaches a prompt.
 */

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { chatMessages } from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeUntrustedSummary } from "@/api/lib/memory/memory-extraction-prompt";

// One background extraction must not turn into an unbounded prompt on the
// tenant's own provider key: cap both the rows read and the rendered text.
export const TRANSCRIPT_MAX_MESSAGES = 60;
export const TRANSCRIPT_MAX_CHARS = 12_000;
// Per-message ceiling so one pasted contract cannot consume the whole budget
// and crowd out every other message in the range.
const TRANSCRIPT_MESSAGE_MAX_CHARS = 2000;

type LoadCompactionTranscriptOptions = {
  threadId: SafeId<"chatThread">;
  firstSummarizedMessageId: SafeId<"chatMessage">;
  lastSummarizedMessageId: SafeId<"chatMessage">;
};

/**
 * Load the summarized message range and render it as an escaped transcript.
 *
 * Returns an empty string when the range resolves to nothing (messages since
 * deleted by the user, or a range that no longer exists), which leaves the
 * caller with summary-only extraction rather than an error.
 */
export const loadCompactionTranscript = async ({
  threadId,
  firstSummarizedMessageId,
  lastSummarizedMessageId,
}: LoadCompactionTranscriptOptions): Promise<string> => {
  // The range endpoints are message ids, so resolve them to timestamps and
  // select between those: ids are not ordered, `created_at` is (and is the
  // leading column of `chat_messages_thread_created_idx`).
  const bounds = await rootDb
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        inArray(chatMessages.id, [
          firstSummarizedMessageId,
          lastSummarizedMessageId,
        ]),
      ),
    );

  const first = bounds.find(({ id }) => id === firstSummarizedMessageId);
  const last = bounds.find(({ id }) => id === lastSummarizedMessageId);
  if (!first || !last) {
    return "";
  }

  const rows = await rootDb
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        gte(chatMessages.createdAt, first.createdAt),
        lte(chatMessages.createdAt, last.createdAt),
      ),
    )
    .orderBy(asc(chatMessages.createdAt))
    .limit(TRANSCRIPT_MAX_MESSAGES);

  return renderTranscript(rows);
};

type TranscriptRow = {
  role: string;
  content: Parameters<typeof normalizePersistedChatMessageContent>[0];
};

export const renderTranscript = (rows: readonly TranscriptRow[]): string => {
  const lines: string[] = [];
  let usedChars = 0;

  for (const row of rows) {
    const text = messageText(row.content);
    if (text.length === 0) {
      continue;
    }
    const clipped =
      text.length > TRANSCRIPT_MESSAGE_MAX_CHARS
        ? `${text.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}…`
        : text;
    // Escape after clipping: escaping expands the string, and the delimiter
    // characters must stay encoded no matter where the cut lands.
    const line = `${row.role}: ${escapeUntrustedSummary(clipped)}`;
    if (usedChars + line.length > TRANSCRIPT_MAX_CHARS) {
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  return lines.join("\n");
};

const messageText = (content: TranscriptRow["content"]): string => {
  const message = normalizePersistedChatMessageContent(content);
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") {
      continue;
    }
    const trimmed = part.content.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  // Collapse whitespace so a multi-line payload cannot forge extra
  // `role:` lines once rendered into the transcript.
  return parts.join(" ").replace(/\s+/gu, " ").trim();
};
