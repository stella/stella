import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { chatMessages, chatThreadCompactions } from "@/api/db/schema";
import type { ChatCompactionSummary } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { chatMessageCursorCodec } from "@/api/lib/chat/message-cursor";
import type { TestDatabase } from "@/api/tests/security/test-utils";

export const EMPTY_SUMMARY: ChatCompactionSummary = {
  version: 1,
  blocked: [],
  constraints: [],
  criticalContext: [],
  done: [],
  goal: "Continue the matter.",
  inProgress: [],
  keyDecisions: [],
  modifiedFiles: [],
  nextSteps: [],
  readFiles: [],
};

type SeedActiveChatCompactionOptions = {
  /**
   * Store the cursor as the compactor does (the default), or none, as a chain
   * written before the cursor column landed has.
   */
  cursor?: "boundary-row" | "none" | undefined;
  firstKeptMessageId: SafeId<"chatMessage">;
  firstSummarizedMessageId: SafeId<"chatMessage">;
  lastSummarizedMessageId: SafeId<"chatMessage">;
  summarizedMessageCount: number;
  summaryMarkdown?: string | undefined;
  testDb: TestDatabase;
  threadId: SafeId<"chatThread">;
};

/**
 * Install an active compaction checkpoint whose summary ends at
 * `lastSummarizedMessageId`, the way the compactor's advance writes one.
 */
export const seedActiveChatCompaction = async ({
  cursor = "boundary-row",
  firstKeptMessageId,
  firstSummarizedMessageId,
  lastSummarizedMessageId,
  summarizedMessageCount,
  summaryMarkdown = "## Goal\nContinue the matter.",
  testDb,
  threadId,
}: SeedActiveChatCompactionOptions): Promise<
  SafeId<"chatThreadCompaction">
> => {
  // The window seeks from the checkpoint's cursor, so it must be built from
  // the boundary row's own microsecond timestamp as the compactor stores it.
  // A JS Date would truncate to milliseconds and re-admit same-millisecond
  // rows.
  const boundary = await testDb
    .select({
      createdAtCursor:
        chatMessageCursorCodec.cursorValue.as("created_at_cursor"),
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, lastSummarizedMessageId))
    .limit(1);
  const boundaryCursor =
    boundary.at(0)?.createdAtCursor ??
    panic("seed precondition failed: boundary message not found");

  const id = toSafeId<"chatThreadCompaction">(Bun.randomUUIDv7());
  await testDb.insert(chatThreadCompactions).values({
    id,
    threadId,
    status: "active",
    summary: EMPTY_SUMMARY,
    summaryMarkdown,
    firstSummarizedMessageId,
    lastSummarizedMessageId,
    firstKeptMessageId,
    summarizedMessageCount,
    totalSummarizedMessageCount: summarizedMessageCount,
    deltaCursor:
      cursor === "none"
        ? null
        : chatMessageCursorCodec.encode(
            boundaryCursor,
            lastSummarizedMessageId,
          ),
    totalTokens: 70_000,
    preservedTokens: 30_000,
    promptVersion: 1,
  });
  return id;
};
