import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import {
  findTranscriptProblems,
  findTranscriptViolations,
  PROVIDER_WIRE_FORMATS,
  providerWireFormatOf,
  signedGeminiCallsOf,
} from "@/api/tests/helpers/provider-request-transcript";
import type {
  ProducedStep,
  ProviderRequest,
  ProviderWireFormat,
} from "@/api/tests/helpers/provider-request-transcript";

// The transcript check holds every provider's request to one rule set. Each
// wire format is read from the shape its adapter sends (the bodies below are
// trimmed from the adapters' own requests), so a settled request passes and
// each unsettled variant fails with the finding that names its defect.

const problemsOf = (request: ProviderRequest): string[] =>
  findTranscriptProblems(request).map(({ problem }) => problem);

/** A conversation in one format: a user message, a model message making
 *  `calls`, and then `results` (ids), each as the format writes them. */
type WireConversation = (options: {
  calls: readonly string[];
  results: readonly string[];
}) => unknown;

const WIRE: Record<ProviderWireFormat, WireConversation> = {
  "anthropic-messages": ({ calls, results }) => ({
    messages: [
      { content: "Delete the draft", role: "user" },
      {
        content: calls.map((id) => ({
          id,
          input: { name: "draft" },
          name: "mcp__external__delete",
          type: "tool_use",
        })),
        role: "assistant",
      },
      {
        content: results.map((id) => ({
          content: '{"deleted":"draft"}',
          tool_use_id: id,
          type: "tool_result",
        })),
        role: "user",
      },
    ],
  }),
  "bedrock-converse": ({ calls, results }) => ({
    messages: [
      { content: [{ text: "Delete the draft" }], role: "user" },
      {
        content: calls.map((toolUseId) => ({
          toolUse: {
            input: { name: "draft" },
            name: "mcp__external__delete",
            toolUseId,
          },
        })),
        role: "assistant",
      },
      {
        content: results.map((toolUseId) => ({
          toolResult: {
            content: [{ text: '{"deleted":"draft"}' }],
            status: "success",
            toolUseId,
          },
        })),
        role: "user",
      },
    ],
  }),
  gemini: ({ calls, results }) => ({
    contents: [
      { parts: [{ text: "Delete the draft" }], role: "user" },
      {
        parts: calls.map((id) => ({
          functionCall: { args: { name: "draft" }, id, name: "delete" },
          thoughtSignature: "EoYCCoMC",
        })),
        role: "model",
      },
      {
        parts: results.map((id) => ({
          functionResponse: {
            id,
            name: "delete",
            response: { content: '{"deleted":"draft"}' },
          },
        })),
        role: "user",
      },
    ],
  }),
  "openai-chat": ({ calls, results }) => ({
    messages: [
      { content: "You are stella.", role: "system" },
      { content: "Delete the draft", role: "user" },
      {
        content: null,
        role: "assistant",
        tool_calls: calls.map((id) => ({
          function: { arguments: '{"name":"draft"}', name: "delete" },
          id,
          type: "function",
        })),
      },
      ...results.map((id) => ({
        content: '{"deleted":"draft"}',
        role: "tool",
        tool_call_id: id,
      })),
    ],
  }),
  "openai-responses": ({ calls, results }) => ({
    input: [
      {
        content: [{ text: "Delete the draft", type: "input_text" }],
        role: "user",
        type: "message",
      },
      ...calls.map((id) => ({
        arguments: '{"name":"draft"}',
        call_id: id,
        name: "delete",
        type: "function_call",
      })),
      ...results.map((id) => ({
        call_id: id,
        output: '{"deleted":"draft"}',
        type: "function_call_output",
      })),
    ],
  }),
};

const wire = (
  format: ProviderWireFormat,
  calls: readonly string[],
  results: readonly string[],
): ProviderRequest => ({ body: WIRE[format]({ calls, results }), format });

describe("a request's tool calls and results pair up", () => {
  for (const format of PROVIDER_WIRE_FORMATS) {
    test(`${format}: a settled request passes`, () => {
      expect(problemsOf(wire(format, ["a", "b"], ["b", "a"]))).toEqual([]);
    });

    test(`${format}: a call without its result is a finding`, () => {
      expect(
        findTranscriptProblems(wire(format, ["a", "b"], ["a"])),
      ).toContainEqual(
        expect.objectContaining({
          problem: "a tool call has no result right after its message",
          toolCallId: "b",
        }),
      );
    });

    test(`${format}: a result for a call the message does not hold is a finding`, () => {
      expect(problemsOf(wire(format, ["a"], ["a", "z"]))).toEqual([
        "a tool result answers no call of the message before it",
      ]);
    });

    test(`${format}: a call answered twice is a finding`, () => {
      expect(problemsOf(wire(format, ["a"], ["a", "a"]))).toEqual([
        "a tool call has more than one result",
      ]);
    });

    test(`${format}: a result with no call before it is a finding`, () => {
      expect(problemsOf(wire(format, [], ["a"]))).toEqual([
        "a tool result follows no call of the message before it",
      ]);
    });
  }

  test("a call id used twice in one request is a finding", () => {
    const body = {
      messages: [
        { content: "Delete both", role: "user" },
        ...["a", "a"].flatMap((id) => [
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: "{}", name: "delete" },
                id,
                type: "function",
              },
            ],
          },
          { content: "{}", role: "tool", tool_call_id: id },
        ]),
      ],
    };
    expect(problemsOf({ body, format: "openai-chat" })).toEqual([
      "a tool call id repeats",
    ]);
  });

  test("an Anthropic result after other content in its message is a finding", () => {
    const body = {
      messages: [
        { content: "Delete the draft", role: "user" },
        {
          content: [{ id: "a", input: {}, name: "delete", type: "tool_use" }],
          role: "assistant",
        },
        {
          content: [
            { text: "Also this", type: "text" },
            { content: "{}", tool_use_id: "a", type: "tool_result" },
          ],
          role: "user",
        },
      ],
    };
    expect(problemsOf({ body, format: "anthropic-messages" })).toEqual([
      "a tool call has no result right after its message",
      "a tool result follows no call of the message before it",
    ]);
  });

  test("Gemini calls without ids pair by position in each tool cycle", () => {
    const cycle = (args: string) => [
      {
        parts: [{ functionCall: { args: { name: args }, name: "delete" } }],
        role: "model",
      },
      {
        parts: [{ functionResponse: { name: "delete", response: {} } }],
        role: "user",
      },
    ];
    const settled = {
      contents: [
        { parts: [{ text: "Delete both drafts" }], role: "user" },
        ...cycle("first"),
        ...cycle("second"),
      ],
    };
    expect(problemsOf({ body: settled, format: "gemini" })).toEqual([]);

    const extra = {
      contents: [
        ...settled.contents,
        {
          parts: [{ functionResponse: { name: "delete", response: {} } }],
          role: "user",
        },
      ],
    };
    expect(problemsOf({ body: extra, format: "gemini" })).toEqual([
      "a tool result follows no call of the message before it",
    ]);
  });

  test("a body the check cannot read is a finding, not a pass", () => {
    for (const format of PROVIDER_WIRE_FORMATS) {
      expect(problemsOf({ body: { unexpected: [] }, format })).not.toEqual([]);
    }
  });
});

describe("signed thinking keeps its place", () => {
  const anthropicTurn = (content: unknown[]): ProviderRequest => ({
    body: {
      messages: [
        { content: "Delete the draft", role: "user" },
        { content, role: "assistant" },
        {
          content: [{ content: "{}", tool_use_id: "a", type: "tool_result" }],
          role: "user",
        },
      ],
    },
    format: "anthropic-messages",
  });
  const toolUse = { id: "a", input: {}, name: "delete", type: "tool_use" };
  const signedThinking = {
    signature: "sig-1",
    thinking: "Plan",
    type: "thinking",
  };

  test("thinking that opens its message passes", () => {
    expect(problemsOf(anthropicTurn([signedThinking, toolUse]))).toEqual([]);
  });

  test("thinking after the call it was produced with is a finding", () => {
    expect(problemsOf(anthropicTurn([toolUse, signedThinking]))).toEqual([
      "a thinking block follows the message's text or calls",
    ]);
  });

  test("Anthropic thinking without its signature is a finding", () => {
    expect(
      problemsOf(
        anthropicTurn([{ ...signedThinking, signature: "" }, toolUse]),
      ),
    ).toEqual(["a thinking block has no signature"]);
  });

  test("a Gemini call replayed without the signature it was produced with is a finding", () => {
    const answer = `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { args: {}, id: "a", name: "delete" },
                thoughtSignature: "EoYCCoMC",
              },
            ],
            role: "model",
          },
        },
      ],
    })}\r\n\r\n`;
    const signedCalls = new Map(signedGeminiCallsOf(answer));
    expect([...signedCalls]).toEqual([["a", "EoYCCoMC"]]);

    const replayed = (part: Record<string, unknown>): ProviderRequest => ({
      body: {
        contents: [
          { parts: [{ text: "Delete the draft" }], role: "user" },
          {
            parts: [
              { functionCall: { args: {}, id: "a", name: "delete" }, ...part },
            ],
            role: "model",
          },
          {
            parts: [
              { functionResponse: { id: "a", name: "delete", response: {} } },
            ],
            role: "user",
          },
        ],
      },
      format: "gemini",
      signedCalls,
    });
    expect(problemsOf(replayed({ thoughtSignature: "EoYCCoMC" }))).toEqual([]);
    expect(problemsOf(replayed({}))).toEqual([
      "a replayed tool call lost the thinking produced with it",
    ]);
  });

  test("Bedrock reasoning without its signature is a finding", () => {
    const body = {
      messages: [
        { content: [{ text: "Delete the draft" }], role: "user" },
        {
          content: [
            { reasoningContent: { reasoningText: { text: "Plan" } } },
            { toolUse: { input: {}, name: "delete", toolUseId: "a" } },
          ],
          role: "assistant",
        },
        {
          content: [{ toolResult: { content: [], toolUseId: "a" } }],
          role: "user",
        },
      ],
    };
    expect(problemsOf({ body, format: "bedrock-converse" })).toEqual([
      "a thinking block has no signature",
    ]);
  });

  // Two model calls of one turn: the first thought and called `a`, the
  // second thought and answered. Handed to the provider again, each thinking
  // block stays on its own step's message.
  const steps: ProducedStep[] = [
    { signatures: ["sig-1"], toolCallIds: ["a"] },
    { signatures: ["sig-2"], toolCallIds: [] },
  ];
  const call = (id: string) => ({
    function: { arguments: "{}", name: "delete" },
    id,
    type: "function" as const,
  });
  const turn = (messages: ModelMessage[]): ProviderRequest => ({
    earlierSteps: steps,
    format: "model-messages",
    messages: [
      { content: "Delete the draft", role: "user" },
      ...messages,
      { content: "And the other one", role: "user" },
    ],
  });
  const plan = { content: "Plan", signature: "sig-1" };
  const done = { content: "Done", signature: "sig-2" };
  const result: ModelMessage = { content: "{}", role: "tool", toolCallId: "a" };
  const callMessage = (thinking: { content: string; signature: string }[]) =>
    ({
      content: null,
      role: "assistant",
      thinking,
      toolCalls: [call("a")],
    }) satisfies ModelMessage;
  const answer = (thinking: { content: string; signature: string }[]) =>
    ({
      content: "Deleted",
      role: "assistant",
      thinking,
    }) satisfies ModelMessage;

  test("each step's thinking on its own message passes", () => {
    expect(
      problemsOf(turn([callMessage([plan]), result, answer([done])])),
    ).toEqual([]);
  });

  test("a later step's thinking moved onto the call's message is a finding", () => {
    // What merging a turn's steps into one message makes of them.
    expect(
      problemsOf(
        turn([{ ...callMessage([plan, done]), content: "Deleted" }, result]),
      ),
    ).toEqual([
      "a thinking block sits on another message than the calls it was produced with",
    ]);
  });

  test("thinking out of the order it was produced in is a finding", () => {
    expect(
      problemsOf(turn([callMessage([done]), result, answer([plan])])),
    ).toContain("a thinking block comes before one produced ahead of it");
  });

  test("a replayed call that lost its thinking is a finding", () => {
    expect(problemsOf(turn([callMessage([]), result, answer([done])]))).toEqual(
      ["a replayed tool call lost the thinking produced with it"],
    );
  });
});

describe("the engine's messages", () => {
  // A batch of an approval, a clarification and an approval, superseded by a
  // new message: the clarification's closing result split the batch, and
  // the denials the engine answers at the end of the message no longer
  // followed the message making the first call.
  test("a batch split by one call's result is a finding", () => {
    const deleteCall = (id: string) => ({
      function: { arguments: "{}", name: "mcp__external__delete" },
      id,
      type: "function" as const,
    });
    const denied = '{"approved":false,"message":"User denied this action"}';
    const request: ProviderRequest = {
      earlierSteps: [],
      format: "model-messages",
      messages: [
        { content: "Draft the NDA", role: "user" },
        {
          content: null,
          role: "assistant",
          toolCalls: [
            deleteCall("call-2"),
            {
              function: { arguments: "{}", name: "ask-user" },
              id: "call-3",
              type: "function",
            },
          ],
        },
        { content: "{}", role: "tool", toolCallId: "call-3" },
        { content: null, role: "assistant", toolCalls: [deleteCall("call-4")] },
        { content: denied, role: "tool", toolCallId: "call-2" },
        { content: denied, role: "tool", toolCallId: "call-4" },
        { content: "Use the buyer's form", role: "user" },
      ],
    };
    expect(findTranscriptViolations([request])).toEqual([
      {
        detail: {
          format: "model-messages",
          message: 1,
          problem: "a tool call has no result right after its message",
          request: 0,
          toolCallId: "call-2",
        },
        oracle: CHAT_ORACLE.providerTranscriptSettled,
      },
      {
        detail: {
          format: "model-messages",
          message: 3,
          problem: "a tool result answers no call of the message before it",
          request: 0,
          toolCallId: "call-2",
        },
        oracle: CHAT_ORACLE.providerTranscriptSettled,
      },
    ]);
  });
});

describe("the wire format of a provider request", () => {
  test.each([
    ["https://api.anthropic.com/v1/messages?beta=true", "anthropic-messages"],
    [
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse-stream",
      "bedrock-converse",
    ],
    [
      "https://generativelanguage.googleapis.com/v1beta/models/g:streamGenerateContent?alt=sse",
      "gemini",
    ],
    ["https://api.mistral.ai/v1/chat/completions", "openai-chat"],
    ["https://openrouter.ai/api/v1/chat/completions", "openai-chat"],
    ["https://api.openai.com/v1/responses", "openai-responses"],
    ["https://api.anthropic.com/v1/models", null],
  ] satisfies [string, ProviderWireFormat | null][])(
    "%s is %s",
    (url, format) => {
      expect(providerWireFormatOf(new URL(url))).toBe(format);
    },
  );
});
