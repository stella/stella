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
 * Everything here is untrusted tenant content. It is flattened and hard-capped
 * before the prompt constructor escapes it at the trust boundary.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { chatMessages } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
 * Load the summarized message range and render it as a bounded transcript.
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
  // Resolve both endpoint tuples in one bounded query. `created_at` alone is
  // not a stable boundary because messages inserted in one transaction can
  // share it; UUID id is the same tie-breaker used by chat history.
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
        sql`(${chatMessages.createdAt}, ${chatMessages.id}) >= (${first.createdAt}, ${first.id})`,
        sql`(${chatMessages.createdAt}, ${chatMessages.id}) <= (${last.createdAt}, ${last.id})`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(TRANSCRIPT_MAX_MESSAGES);

  return renderTranscript(rows);
};

type TranscriptRow = {
  role: string;
  content: typeof chatMessages.$inferSelect.content;
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
    const line = `${row.role}: ${clipped}`;
    if (usedChars + line.length > TRANSCRIPT_MAX_CHARS) {
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  return lines.join("\n");
};

const messageText = (content: TranscriptRow["content"]): string => {
  const parts: string[] = [];
  for (const part of content.data) {
    const text = persistedTextPartContent(part);
    const trimmed = text?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  // Collapse whitespace so a multi-line payload cannot forge extra
  // `role:` lines once rendered into the transcript.
  return parts.join(" ").replace(/\s+/gu, " ").trim();
};

const persistedTextPartContent = (part: unknown): string | null => {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return null;
  }
  if (part.type !== "text") {
    return null;
  }
  if ("content" in part && typeof part.content === "string") {
    return part.content;
  }
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }
  return null;
};
