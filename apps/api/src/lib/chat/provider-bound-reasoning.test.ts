import type { ModelMessage } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { buildClosedTranscript } from "@/api/lib/chat/closed-transcript";

type InputItem = { id?: string; role?: string; type: string };

// What the adapter packs when the request asks for encrypted reasoning: the
// item id and its encrypted content, so the item can be replayed whole.
const responsesSignature = (id: string) =>
  JSON.stringify({ id, encrypted_content: `enc_${id}` });

const thinkingFor = (ids: readonly string[]) =>
  ids.map((id) => ({
    content: `summary ${id}`,
    signature: responsesSignature(id),
    provenance: {
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-encrypted-content",
    },
  }));

// A call the model made while reasoning carries the item id that pairs it
// with that reasoning; a call made without reasoning pairs with nothing.
const callFor = (index: number, reasoned: boolean) => ({
  function: { arguments: "{}", name: "save_contact" },
  id: `call_${index}`,
  ...(reasoned ? { metadata: { itemId: `fc_${index}` } } : {}),
  type: "function" as const,
});

const assistant = ({
  calls = 0,
  reasoning,
  text,
}: {
  calls?: number;
  reasoning: readonly string[];
  text?: string;
}): ModelMessage => ({
  content: text ?? null,
  role: "assistant",
  ...(reasoning.length > 0 ? { thinking: thinkingFor(reasoning) } : {}),
  ...(calls > 0
    ? {
        toolCalls: Array.from({ length: calls }, (_, i) =>
          callFor(i, reasoning.length > 0),
        ),
      }
    : {}),
});

const declined = (index: number): ModelMessage => ({
  content: JSON.stringify({ approved: false, message: "User denied" }),
  role: "tool",
  toolCallId: `call_${index}`,
});

const USER: ModelMessage = { content: "Save the contact.", role: "user" };

/** The Responses API input the real adapter builds from `messages`. */
const responsesInput = (messages: readonly ModelMessage[]): InputItem[] => {
  const adapter = createOpenaiChat("gpt-5.2", "test-key");
  const convert: unknown = Reflect.get(adapter, "convertMessagesToInput");
  if (typeof convert !== "function") {
    return panic("The OpenAI adapter no longer converts messages to input");
  }
  const input: unknown = Reflect.apply(convert, adapter, [messages]);
  if (!Array.isArray(input)) {
    return panic("The OpenAI adapter returned a non-array input");
  }
  return input.map((item: unknown): InputItem => {
    if (typeof item !== "object" || item === null) {
      return panic("The OpenAI adapter returned a non-object input item");
    }
    const type: unknown = Reflect.get(item, "type");
    const id: unknown = Reflect.get(item, "id");
    const role: unknown = Reflect.get(item, "role");
    return {
      type: typeof type === "string" ? type : "message",
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof role === "string" ? { role } : {}),
    };
  });
};

/**
 * The pairing the API enforces, both ways: a replayed reasoning item is
 * followed by the item it led to, so a function call right after reasoning
 * carries its id; and a function call carrying an item id follows the
 * reasoning it was paired with.
 */
const unpairedReasoning = (input: readonly InputItem[]): string[] =>
  input.flatMap((item, index) => {
    if (item.type === "reasoning") {
      const next = input.slice(index + 1).find((n) => n.type !== "reasoning");
      return next?.type === "function_call" && next.id === undefined
        ? [item.id ?? "reasoning"]
        : [];
    }
    if (item.type === "function_call" && item.id !== undefined) {
      const before = input
        .slice(0, index)
        .findLast((n) => n.type !== "function_call");
      return before?.type === "reasoning" ? [] : [item.id];
    }
    return [];
  });

const sentToOpenAI = (messages: readonly ModelMessage[]) =>
  responsesInput(
    buildClosedTranscript({
      messages,
      target: { provider: "openai", modelId: "gpt-5.2" },
      onReasoningDropped: () => undefined,
    }),
  );

describe("OpenAI reasoning replay after a declined call", () => {
  test("one reasoning item stays paired with its call", () => {
    const input = sentToOpenAI([
      USER,
      assistant({ calls: 1, reasoning: ["rs_1"] }),
      declined(0),
    ]);
    expect(input.map(({ type }) => type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input.at(2)?.id).toBe("fc_0");
  });

  test("a call after two reasoning items is sent without them", () => {
    const messages = [
      USER,
      assistant({ calls: 1, reasoning: ["rs_1", "rs_2"], text: "Saving." }),
      declined(0),
    ];
    // The adapter alone sends both reasoning items before an id-less call.
    expect(unpairedReasoning(responsesInput(messages))).toEqual([
      "rs_1",
      "rs_2",
    ]);
    const input = sentToOpenAI(messages);
    expect(input.some(({ type }) => type === "reasoning")).toBe(false);
    expect(
      input.filter(({ type }) => type === "function_call").map(({ id }) => id),
    ).toEqual([undefined]);
    expect(unpairedReasoning(input)).toEqual([]);
  });

  test("a reasoning id replayed earlier does not unpair a later call", () => {
    const input = sentToOpenAI([
      USER,
      assistant({ reasoning: ["rs_1"], text: "Looking." }),
      assistant({ calls: 1, reasoning: ["rs_1"] }),
      declined(0),
    ]);
    expect(unpairedReasoning(input)).toEqual([]);
  });

  test("reasoning before text alone is replayed untouched", () => {
    const messages = [
      USER,
      assistant({ reasoning: ["rs_1", "rs_2"], text: "Done." }),
    ];
    expect([
      ...buildClosedTranscript({
        messages,
        target: { provider: "openai", modelId: "gpt-5.2" },
        onReasoningDropped: () => undefined,
      }),
    ]).toEqual(messages);
  });

  test("other providers' messages are not reshaped", () => {
    const messages = [
      USER,
      assistant({ calls: 1, reasoning: ["rs_1", "rs_2"] }),
      declined(0),
    ];
    const anthropic = buildClosedTranscript({
      messages,
      target: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      onReasoningDropped: () => undefined,
    });
    expect(anthropic.some((message) => message.thinking !== undefined)).toBe(
      false,
    );
    expect(anthropic.map(({ role }) => role)).toEqual(
      messages.map(({ role }) => role),
    );
  });

  test("no reasoning, call or text count leaves reasoning unpaired", () => {
    const reasoningSets = [
      [],
      ["rs_1"],
      ["rs_1", "rs_2"],
      ["rs_1", "rs_2", "rs_3"],
    ];
    for (const reasoning of reasoningSets) {
      for (const calls of [0, 1, 2]) {
        for (const text of [undefined, "Preamble."]) {
          for (const repeatEarlier of [false, true]) {
            const messages: ModelMessage[] = [
              USER,
              ...(repeatEarlier && reasoning.length > 0
                ? [assistant({ reasoning: reasoning.slice(0, 1), text: "Hm." })]
                : []),
              assistant({ calls, reasoning, ...(text ? { text } : {}) }),
              ...Array.from({ length: calls }, (_, i) => declined(i)),
            ];
            expect({
              calls,
              reasoning,
              repeatEarlier,
              text,
              unpaired: unpairedReasoning(sentToOpenAI(messages)),
            }).toEqual({ calls, reasoning, repeatEarlier, text, unpaired: [] });
          }
        }
      }
    }
  });

  test("a reasoning item replayed by id alone is not sent", () => {
    const byIdOnly: ModelMessage = {
      content: null,
      role: "assistant",
      thinking: [
        { content: "summary rs_1", signature: JSON.stringify({ id: "rs_1" }) },
      ],
      toolCalls: [callFor(0, true)],
    };
    const messages = [USER, byIdOnly, declined(0)];
    // The adapter alone sends the item by id, with nothing to resolve it by.
    expect(
      responsesInput(messages).filter(({ type }) => type === "reasoning"),
    ).toEqual([{ id: "rs_1", type: "reasoning" }]);

    const input = sentToOpenAI(messages);
    expect(input.map(({ type }) => type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(input.at(1)?.id).toBeUndefined();
    expect(unpairedReasoning(input)).toEqual([]);
  });

  test("reasoning stored after a declined call, with nothing after it, is not sent", () => {
    const messages = [
      USER,
      assistant({ calls: 1, reasoning: ["rs_1"] }),
      declined(0),
      assistant({ reasoning: ["rs_2"] }),
    ];
    // The adapter alone ends the request on a reasoning item.
    expect(responsesInput(messages).at(-1)).toEqual({
      id: "rs_2",
      type: "reasoning",
    });

    const input = sentToOpenAI(messages);
    expect(input.map(({ type }) => type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input.at(1)?.id).toBe("rs_1");
    expect(input.at(2)?.id).toBe("fc_0");
  });
});
