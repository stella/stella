import type { ModelMessage } from "ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "@/api/handlers/chat/types";

import {
  compactChatMessages,
  compactModelMessages,
  planChatCompaction,
  planModelCompaction,
  renderChatMessagesForCompaction,
  renderModelMessagesForCompaction,
} from "./compaction";

const textMessage = ({
  id,
  role,
  text,
}: {
  id: string;
  role: ChatMessage["role"];
  text: string;
}): ChatMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("chat history compaction", () => {
  test("keeps full history below the token trigger", () => {
    const messages = [
      textMessage({ id: "msg_1", role: "user", text: "hello" }),
      textMessage({ id: "msg_2", role: "assistant", text: "hi" }),
    ];

    const plan = planChatCompaction({
      messages,
      triggerTokens: 1000,
    });

    expect(plan.type).toBe("none");
  });

  test("summarizes older messages and preserves the recent tail", async () => {
    const messages = [
      textMessage({ id: "msg_1", role: "user", text: "old fact ".repeat(80) }),
      textMessage({
        id: "msg_2",
        role: "assistant",
        text: "old answer ".repeat(80),
      }),
      textMessage({
        id: "msg_3",
        role: "user",
        text: "latest question",
      }),
    ];

    const compacted = await compactChatMessages({
      messages,
      preserveTokens: 20,
      summarizeTranscript: async (transcript) =>
        transcript.includes("old fact") ? "old work summary" : "",
      triggerTokens: 50,
    });

    expect(Result.isOk(compacted)).toBe(true);
    if (Result.isError(compacted)) {
      return;
    }

    expect(compacted.value).toHaveLength(2);
    expect(compacted.value.at(0)?.role).toBe("user");
    expect(compacted.value.at(0)?.parts.at(0)).toEqual({
      type: "text",
      text: "Earlier conversation compacted from 2 message(s).\n\nold work summary",
    });
    expect(compacted.value.at(1)?.id).toBe("msg_3");
  });

  test("preserves chat history from the latest user turn boundary", () => {
    const messages = [
      textMessage({ id: "msg_1", role: "user", text: "old fact ".repeat(80) }),
      textMessage({
        id: "msg_2",
        role: "assistant",
        text: "old answer ".repeat(80),
      }),
      textMessage({
        id: "msg_3",
        role: "user",
        text: "latest question ".repeat(20),
      }),
      textMessage({ id: "msg_4", role: "assistant", text: "working on it" }),
    ];

    const plan = planChatCompaction({
      messages,
      preserveTokens: 20,
      triggerTokens: 50,
    });

    expect(plan.type).toBe("compact");
    if (plan.type === "none") {
      return;
    }

    expect(plan.messagesToSummarize.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_2",
    ]);
    expect(plan.recentMessages.map((message) => message.id)).toEqual([
      "msg_3",
      "msg_4",
    ]);
  });

  test("anonymizes the compaction transcript before summarizing", async () => {
    const messages = [
      textMessage({
        id: "msg_1",
        role: "user",
        text: "Acme s.r.o. signed the NDA.",
      }),
      textMessage({
        id: "msg_2",
        role: "user",
        text: "What obligations survive termination?",
      }),
    ];
    let transcriptSeenBySummarizer = "";

    const compacted = await compactChatMessages({
      messages,
      prepareTranscript: async (transcript) =>
        Result.ok(transcript.replaceAll("Acme s.r.o.", "[ORG_1]")),
      preserveTokens: 10,
      summarizeTranscript: async (transcript) => {
        transcriptSeenBySummarizer = transcript;
        return "summary";
      },
      triggerTokens: 20,
    });

    expect(Result.isOk(compacted)).toBe(true);
    expect(transcriptSeenBySummarizer).toContain("[ORG_1]");
    expect(transcriptSeenBySummarizer).not.toContain("Acme s.r.o.");
  });

  test("masks bulky file attachments in the transcript", () => {
    const transcript = renderChatMessagesForCompaction([
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "file",
            filename: "contract.pdf",
            mediaType: "application/pdf",
            url: "stella-user-file://file_1",
          },
        ],
      },
    ]);

    expect(transcript).toContain("contract.pdf");
    expect(transcript).toContain("old file attachments are not rehydrated");
    expect(transcript).not.toContain("stella-user-file://file_1");
  });

  test("falls back to the recent tail when summary generation fails", async () => {
    const messages = [
      textMessage({ id: "msg_1", role: "user", text: "old fact ".repeat(80) }),
      textMessage({ id: "msg_2", role: "user", text: "latest question" }),
    ];
    let observedSummaryError = false;

    const compacted = await compactChatMessages({
      messages,
      onSummaryError: () => {
        observedSummaryError = true;
      },
      preserveTokens: 20,
      summarizeTranscript: async () => {
        throw new Error("provider unavailable");
      },
      triggerTokens: 50,
    });

    expect(Result.isOk(compacted)).toBe(true);
    if (Result.isError(compacted)) {
      return;
    }

    expect(observedSummaryError).toBe(true);
    expect(compacted.value.map((message) => message.id)).toEqual(["msg_2"]);
  });

  test("compacts model messages for step-level tool loops", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request ".repeat(80) },
      {
        role: "assistant",
        content: [{ type: "text", text: "old tool finding ".repeat(80) }],
      },
      { role: "user", content: "latest request" },
    ];

    const compacted = await compactModelMessages({
      messages,
      preserveTokens: 20,
      summarizeTranscript: async (transcript) =>
        transcript.includes("old request") ? "step summary" : "",
      triggerTokens: 50,
    });

    expect(Result.isOk(compacted)).toBe(true);
    if (Result.isError(compacted)) {
      return;
    }

    expect(compacted.value).toEqual([
      {
        role: "user",
        content:
          "Earlier model-step history compacted from 2 message(s).\n\nstep summary",
      },
      { role: "user", content: "latest request" },
    ]);
  });

  test("preserves model history from the latest user turn boundary", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request ".repeat(80) },
      { role: "assistant", content: "old answer ".repeat(80) },
      { role: "user", content: "latest request ".repeat(20) },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "searchMatter",
            input: { query: "termination" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "searchMatter",
            output: { type: "json", value: { finding: "survives" } },
          },
        ],
      },
    ];

    const plan = planModelCompaction({
      messages,
      preserveTokens: 20,
      triggerTokens: 50,
    });

    expect(plan.type).toBe("compact");
    if (plan.type === "none") {
      return;
    }

    expect(plan.messagesToSummarize.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(plan.recentMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  test("skips model-message compaction below the token trigger", () => {
    const plan = planModelCompaction({
      messages: [{ role: "user", content: "small" }],
      triggerTokens: 1000,
    });

    expect(plan.type).toBe("none");
  });

  test("renders non-json structured parts without failing compaction", () => {
    const transcript = renderModelMessagesForCompaction([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "searchMatter",
            input: { value: 1n },
          },
        ],
      },
    ]);

    expect(transcript).toContain("[unserializable]");
  });
});
