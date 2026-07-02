import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";

import {
  compactChatMessages,
  compactModelMessagesForModel,
  compactModelMessages,
  parseChatCompactionSummary,
  planChatCompaction,
  planModelCompaction,
  renderChatMessagesForCompaction,
  renderModelMessagesForCompaction,
  shouldCompactChatMessages,
  summarizeChatCompaction,
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
  parts: [{ type: "text", content: text }],
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
      content:
        "Earlier conversation compacted from 2 message(s).\n\nold work summary",
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
          createChatAttachmentPart({
            filename: "contract.pdf",
            mimeType: "application/pdf",
            url: "stella-user-file://file_1",
          }),
        ],
      },
    ]);

    expect(transcript).toContain("contract.pdf");
    expect(transcript).toContain(
      "content: omitted; attachments are not inlined during compaction",
    );
    expect(transcript).not.toContain("stella-user-file://file_1");
  });

  test("omits anonymization restoration metadata from the transcript", () => {
    const transcript = renderChatMessagesForCompaction([
      {
        id: "msg_1",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [
              {
                placeholder: "[ORG_1]",
                original: "Confidential Client LLC",
              },
            ],
          },
        },
        parts: [
          {
            type: "text",
            content: "The answer references [ORG_1].",
          },
        ],
      },
    ]);

    expect(transcript).toContain("The answer references [ORG_1].");
    expect(transcript).not.toContain("Confidential Client LLC");
  });

  test("ignores anonymization restoration metadata when planning compaction", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [
              {
                placeholder: "[ORG_1]",
                original: "Confidential Client LLC ".repeat(1000),
              },
            ],
          },
        },
        parts: [
          {
            type: "text",
            content: "The answer references [ORG_1].",
          },
        ],
      },
    ];

    expect(shouldCompactChatMessages(messages, 1000)).toBe(false);
    expect(planChatCompaction({ messages, triggerTokens: 1000 }).type).toBe(
      "none",
    );
  });

  test("drops restoration-only messages from transcript and planning", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [
              {
                placeholder: "[ORG_1]",
                original: "Confidential Client LLC ".repeat(1000),
              },
            ],
          },
        },
        parts: [],
      },
    ];

    expect(renderChatMessagesForCompaction(messages)).toBe("");
    expect(shouldCompactChatMessages(messages, 1)).toBe(false);
    expect(planChatCompaction({ messages, triggerTokens: 1 }).type).toBe(
      "none",
    );
  });

  test("ignores restoration-only messages when finding the preserved tail", () => {
    const messages: ChatMessage[] = [
      textMessage({ id: "msg_1", role: "user", text: "old fact ".repeat(80) }),
      textMessage({
        id: "msg_2",
        role: "assistant",
        text: "old answer ".repeat(80),
      }),
      {
        id: "msg_3",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [
              {
                placeholder: "[ORG_1]",
                original: "Confidential Client LLC",
              },
            ],
          },
        },
        parts: [],
      },
      textMessage({ id: "msg_4", role: "user", text: "latest question" }),
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
    expect(plan.recentMessages.map((message) => message.id)).toEqual(["msg_4"]);
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

  test("parses structured chat compaction summaries", () => {
    const summary = parseChatCompactionSummary(`
## Goal
Continue drafting the termination analysis.

## Constraints
- Czech governing law
- Preserve party placeholders

## Progress
### Done
- Reviewed clause 12
### In Progress
- Comparing notice periods
### Blocked
- Need signed amendment

## Key Decisions
- Use conservative interpretation - clause text is ambiguous

## Next Steps
- Pull amendment file

## Critical Context
- User prefers concise answers

<read-files>
- contracts/main-agreement.pdf
</read-files>
<modified-files>
- drafts/termination.md
</modified-files>
`);

    expect(summary).toEqual({
      version: 1,
      blocked: ["Need signed amendment"],
      constraints: ["Czech governing law", "Preserve party placeholders"],
      criticalContext: ["User prefers concise answers"],
      done: ["Reviewed clause 12"],
      goal: "Continue drafting the termination analysis.",
      inProgress: ["Comparing notice periods"],
      keyDecisions: [
        {
          decision: "Use conservative interpretation",
          rationale: "clause text is ambiguous",
        },
      ],
      modifiedFiles: ["drafts/termination.md"],
      nextSteps: ["Pull amendment file"],
      readFiles: ["contracts/main-agreement.pdf"],
    });
  });

  test("returns a structured checkpoint for persistent compaction", async () => {
    const messages = [
      textMessage({ id: "msg_1", role: "user", text: "old fact ".repeat(80) }),
      textMessage({ id: "msg_2", role: "assistant", text: "old answer" }),
      textMessage({ id: "msg_3", role: "user", text: "latest question" }),
    ];

    const checkpoint = await summarizeChatCompaction({
      messages,
      preserveTokens: 20,
      summarizeTranscript: async () => `
## Goal
Answer the latest question.

## Constraints
- None

## Progress
### Done
- Captured old fact
### In Progress
- None
### Blocked
- None

## Key Decisions
- None

## Next Steps
- Answer user

## Critical Context
- old fact matters

<read-files>
</read-files>
<modified-files>
</modified-files>
`,
      triggerTokens: 50,
    });

    expect(Result.isOk(checkpoint)).toBe(true);
    if (Result.isError(checkpoint) || checkpoint.value === null) {
      return;
    }

    expect(checkpoint.value.plan.messagesToSummarize.map((m) => m.id)).toEqual([
      "msg_1",
      "msg_2",
    ]);
    expect(checkpoint.value.summary.goal).toBe("Answer the latest question.");
    expect(checkpoint.value.summary.done).toEqual(["Captured old fact"]);
    expect(checkpoint.value.plan.recentMessages.map((m) => m.id)).toEqual([
      "msg_3",
    ]);
  });

  test("compacts model messages for step-level tool loops", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request ".repeat(80) },
      {
        role: "assistant",
        content: [{ type: "text", content: "old tool finding ".repeat(80) }],
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

  test("uses the TanStack model wrapper for model compaction summaries", async () => {
    let transcriptSeenBySummarizer = "";

    const compacted = await compactModelMessagesForModel({
      abortSignal: AbortSignal.timeout(1000),
      messages: [
        { role: "user", content: "old request ".repeat(80) },
        { role: "assistant", content: "old response ".repeat(80) },
        { role: "user", content: "latest request" },
      ],
      organizationId: toSafeId<"organization">("org_compaction"),
      orgAIConfig: null,
      preserveTokens: 20,
      role: "chat",
      summarizeWithModel: async (transcript) => {
        transcriptSeenBySummarizer = transcript;
        return "tanstack summary";
      },
      triggerTokens: 50,
    });

    expect(Result.isOk(compacted)).toBe(true);
    if (Result.isError(compacted)) {
      return;
    }
    expect(transcriptSeenBySummarizer).toContain("old request");
    expect(compacted.value.at(0)).toEqual({
      role: "user",
      content:
        "Earlier model-step history compacted from 2 message(s).\n\ntanstack summary",
    });
  });

  test("preserves model history from the latest user turn boundary", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request ".repeat(80) },
      { role: "assistant", content: "old answer ".repeat(80) },
      { role: "user", content: "latest request ".repeat(20) },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "searchMatter",
              arguments: JSON.stringify({ query: "termination" }),
            },
          },
        ],
      },
      {
        role: "tool",
        content: "searchMatter result: survives",
        toolCallId: "call_1",
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
            type: "text",
            content: "search",
            metadata: { value: 1n },
          },
        ],
      },
    ]);

    expect(transcript).toContain("[unserializable]");
  });
});
