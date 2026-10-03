import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { createLoopRecoverySystemPrompt } from "@/api/handlers/chat/loop-detector";
import {
  createPromptPrefixLedger,
  promptBlocksOf,
} from "@/api/tests/helpers/chat-prompt-prefix";
import type { ModelRequestPrompt } from "@/api/tests/helpers/chat-prompt-prefix";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const SYSTEM = "You answer legal questions.";
const tool = (name: string) =>
  asTestRaw<NonNullable<ModelRequestPrompt["tools"]>[number]>({
    description: `The ${name} tool`,
    execute: () => undefined,
    inputSchema: { properties: {}, type: "object" },
    name,
  });
const TOOLS = [tool("list_templates"), tool("read_document")];

const user = (content: string): ModelMessage => ({ content, role: "user" });
const answer = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

const breaksOf = (...prompts: Partial<ModelRequestPrompt>[]) => {
  const ledger = createPromptPrefixLedger();
  for (const prompt of prompts) {
    ledger.record(
      promptBlocksOf({
        messages: prompt.messages ?? [],
        systemPrompts: prompt.systemPrompts ?? [SYSTEM],
        tools: prompt.tools ?? TOOLS,
      }),
    );
  }
  return ledger.takeBreaks();
};

describe("the prompt prefix of a thread's model calls", () => {
  test("holds while each call appends to the one before", () => {
    expect(
      breaksOf(
        { messages: [user("Draft an NDA")] },
        { messages: [user("Draft an NDA"), answer("Done"), user("Thanks")] },
      ),
    ).toEqual([]);
  });

  test("breaks when a later call reorders its tools", () => {
    expect(
      breaksOf(
        { messages: [user("Draft an NDA")] },
        { messages: [user("Draft an NDA")], tools: TOOLS.toReversed() },
      ),
    ).toMatchObject([{ block: { index: 0, segment: "tools" }, call: 1 }]);
  });

  test("breaks when a later call's system prompt changes", () => {
    expect(
      breaksOf(
        { messages: [user("Draft an NDA")] },
        {
          messages: [user("Draft an NDA")],
          systemPrompts: [`${SYSTEM}\nNow: 12:00`],
        },
      ),
    ).toMatchObject([{ block: { index: 0, segment: "system" }, call: 1 }]);
  });

  test("ignores what never reaches the provider's cached prefix", () => {
    const live: ModelMessage = { content: "Draft an NDA", role: "user" };
    const hydrated: ModelMessage = {
      createdAt: new Date(0),
      id: "message-1",
      metadata: { source: "history" },
      role: "user",
      content: "Draft an NDA",
    };
    expect(
      breaksOf(
        {
          messages: [live],
          systemPrompts: [
            { content: SYSTEM, metadata: { cache_control: { type: "a" } } },
          ],
        },
        {
          messages: [hydrated],
          systemPrompts: [{ content: SYSTEM, metadata: {} }],
        },
      ),
    ).toEqual([]);
  });

  test("lets a loop-recovery prompt come and go", () => {
    const recovery = createLoopRecoverySystemPrompt({
      baseSystem: SYSTEM,
      detection: {
        repetitionCount: 5,
        signature: "list_templates:{}",
        toolName: "list_templates",
        type: "tool-call-loop",
      },
    });
    expect(recovery.startsWith(SYSTEM)).toBe(true);
    expect(recovery).not.toBe(SYSTEM);
    expect(
      breaksOf(
        { messages: [user("Draft an NDA")] },
        { messages: [user("Draft an NDA")], systemPrompts: [recovery] },
        { messages: [user("Draft an NDA"), answer("Done")] },
      ),
    ).toEqual([]);
  });

  test("lets a regenerated answer replace everything after its question", () => {
    const ledger = createPromptPrefixLedger();
    const record = (messages: ModelMessage[]) => {
      ledger.record(
        promptBlocksOf({ messages, systemPrompts: [SYSTEM], tools: TOOLS }),
      );
    };
    record([user("Draft an NDA"), answer("Here"), user("Shorter")]);
    record([
      user("Draft an NDA"),
      answer("Here"),
      user("Shorter"),
      answer("Short"),
    ]);
    ledger.replacesTail();
    record([user("Draft an NDA"), answer("Here"), user("Shorter")]);
    // A regeneration still keeps everything up to the question it answers.
    ledger.replacesTail();
    record([user("Draft an NDA"), answer("Rewritten"), user("Shorter")]);
    expect(ledger.takeBreaks()).toMatchObject([
      { block: { index: 1, segment: "messages" }, call: 3 },
    ]);
  });

  test("compares the call after a process died with the call before it", () => {
    const ledger = createPromptPrefixLedger();
    const record = (messages: ModelMessage[]) => {
      ledger.record(
        promptBlocksOf({ messages, systemPrompts: [SYSTEM], tools: TOOLS }),
      );
    };
    record([user("Delete the NDA")]);
    const mark = ledger.mark();
    record([user("Delete the NDA"), answer("Deleted")]);
    ledger.loseSince(mark);
    record([user("Delete the NDA"), answer("Not saved")]);
    record([user("Delete the NDA"), answer("Changed")]);
    expect(ledger.takeBreaks()).toMatchObject([
      { block: { index: 1, segment: "messages" }, call: 3, extends: 2 },
    ]);
  });

  test("starts over after a compaction and holds the calls after it", () => {
    const ledger = createPromptPrefixLedger();
    const record = (messages: ModelMessage[]) => {
      ledger.record(
        promptBlocksOf({ messages, systemPrompts: [SYSTEM], tools: TOOLS }),
      );
    };
    record([user("Draft an NDA"), answer("Here"), user("Shorter")]);
    ledger.compacted();
    record([user("Summary: an NDA was drafted"), user("Shorter")]);
    record([user("Summary: an NDA was rewritten"), user("Shorter")]);
    // Only the call that rewrote the summary breaks: the compaction itself
    // is sanctioned, and the calls after it must still extend each other.
    expect(ledger.takeBreaks()).toMatchObject([
      { block: { index: 0, segment: "messages" }, call: 2, extends: 1 },
    ]);
  });
});
