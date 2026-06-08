import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";

import {
  applyChatCompactionCheckpoint,
  shouldInvalidateChatCompactionCheckpoint,
} from "./persistent-compaction";

const message = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("persistent chat compaction", () => {
  test("re-expands a checkpoint into summary plus kept tail", () => {
    const keptId = "22222222-2222-4222-8222-222222222222";
    const messages = [
      message("11111111-1111-4111-8111-111111111111", "old"),
      message(keptId, "kept"),
      message("33333333-3333-4333-8333-333333333333", "latest"),
    ];

    const applied = applyChatCompactionCheckpoint({
      messages,
      checkpoint: {
        id: toSafeId<"chatThreadCompaction">(
          "44444444-4444-4444-8444-444444444444",
        ),
        firstKeptMessageId: toSafeId<"chatMessage">(keptId),
        summarizedMessageCount: 1,
        summaryMarkdown: "## Goal\nContinue the matter.",
        summary: {
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
        },
      },
    });

    expect(applied?.map((item) => item.id)).toEqual([
      "stella-chat-compaction-summary",
      keptId,
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  test("ignores a checkpoint whose first kept message is absent", () => {
    const applied = applyChatCompactionCheckpoint({
      messages: [message("11111111-1111-4111-8111-111111111111", "old")],
      checkpoint: {
        id: toSafeId<"chatThreadCompaction">(
          "44444444-4444-4444-8444-444444444444",
        ),
        firstKeptMessageId: toSafeId<"chatMessage">(
          "22222222-2222-4222-8222-222222222222",
        ),
        summarizedMessageCount: 1,
        summaryMarkdown: "summary",
        summary: {
          version: 1,
          blocked: [],
          constraints: [],
          criticalContext: [],
          done: [],
          goal: null,
          inProgress: [],
          keyDecisions: [],
          modifiedFiles: [],
          nextSteps: [],
          readFiles: [],
        },
      },
    });

    expect(applied).toBeNull();
  });

  test("invalidates active checkpoints when a retained message is updated", () => {
    expect(
      shouldInvalidateChatCompactionCheckpoint({
        deletedMessageCount: 0,
        persistencePlan: { type: "update" },
      }),
    ).toBe(true);
  });

  test("keeps active checkpoints valid for append-only inserts", () => {
    expect(
      shouldInvalidateChatCompactionCheckpoint({
        deletedMessageCount: 0,
        persistencePlan: { type: "insert" },
      }),
    ).toBe(false);
  });
});
