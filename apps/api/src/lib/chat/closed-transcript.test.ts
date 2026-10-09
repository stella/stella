import type { WebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  BYOK_MODEL_OPTIONS,
  getModelReasoningCapabilities,
} from "@stll/ai-catalog";

import {
  buildClosedTranscript,
  continuationThinkingFor,
  TOOL_CLOSE_KINDS,
} from "@/api/lib/chat/closed-transcript";

const call = {
  role: "assistant",
  content: "Calling",
  toolCalls: [
    {
      id: "call-1",
      type: "function",
      function: { name: "save", arguments: "{}" },
    },
  ],
} satisfies ModelMessage;
const target = { provider: "openai", modelId: "gpt-6-sol" } as const;

describe("closed provider transcript", () => {
  for (const status of TOOL_CLOSE_KINDS) {
    test(`closes a ${status} result before later text`, () => {
      const result = {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ status }),
      } satisfies ModelMessage;
      const later = {
        role: "assistant",
        content: "Visible answer",
      } satisfies ModelMessage;
      const closed = buildClosedTranscript({
        messages: [call, later, result],
        target,
      });
      expect([...closed]).toEqual([call, result, later]);
      expect(buildClosedTranscript({ messages: closed, target })).toEqual(
        closed,
      );
    });
  }
  test("closes an interrupted call with one explicit failure", () => {
    const closed = buildClosedTranscript({ messages: [call], target });
    expect(closed).toHaveLength(2);
    expect(closed.at(1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(JSON.parse(String(closed.at(1)?.content))).toMatchObject({
      status: "failed",
    });
    expect(buildClosedTranscript({ messages: closed, target })).toEqual(closed);
  });
  const nativeResult = {
    type: "web_search_tool_result",
    tool_use_id: "call-1",
    content: [
      {
        type: "web_search_result",
        title: "Recorded search result",
        url: "https://example.com/source",
        encrypted_content: "recorded-evidence",
      },
    ],
  } satisfies WebSearchToolResultBlockParam;
  const nativeThinking = {
    content: "Recorded native-tool thinking",
    signature: "recorded-native-signature",
    provenance: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      format: "anthropic-thinking-signature",
    },
  };
  const nativeCall = {
    ...call,
    thinking: [nativeThinking],
    toolCalls: call.toolCalls.map((entry) => ({
      ...entry,
      function: { name: "web_search", arguments: '{"query":"example"}' },
      metadata: {
        providerExecuted: true,
        anthropic: {
          serverToolType: "web_search",
          resultBlockType: nativeResult.type,
          result: nativeResult.content,
        },
      },
    })),
  } satisfies ModelMessage;
  test("keeps Anthropic native tool evidence embedded without an ordinary result", () => {
    const nativeTarget = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    } as const;
    const closed = buildClosedTranscript({
      messages: [nativeCall],
      target: nativeTarget,
    });
    expect([...closed]).toEqual([nativeCall]);
    expect(closed.filter(({ role }) => role === "tool")).toEqual([]);
    expect(
      buildClosedTranscript({ messages: closed, target: nativeTarget }),
    ).toEqual(closed);
  });
  for (const provider of ["openai", "google"] as const) {
    test(`converts native Anthropic evidence to one ordinary result on ${provider}`, () => {
      const switchTarget = {
        provider,
        modelId: BYOK_MODEL_OPTIONS[provider][0],
      };
      const closed = buildClosedTranscript({
        messages: [nativeCall],
        target: switchTarget,
      });
      expect(closed.at(0)?.content).toBe(nativeCall.content);
      expect(closed.at(0)?.thinking).toBeUndefined();
      expect(closed.at(0)?.toolCalls).toEqual(
        nativeCall.toolCalls.map(({ metadata: _native, ...entry }) => entry),
      );
      expect(closed.filter(({ role }) => role === "tool")).toEqual([
        {
          role: "tool",
          toolCallId: "call-1",
          content: JSON.stringify(nativeResult.content),
        },
      ]);
      expect(
        buildClosedTranscript({ messages: closed, target: switchTarget }),
      ).toEqual(closed);
    });
  }
  test("rejects duplicate results and orphan results", () => {
    const result = {
      role: "tool",
      toolCallId: "call-1",
      content: "saved",
    } satisfies ModelMessage;
    expect(() =>
      buildClosedTranscript({ messages: [call, result, result], target }),
    ).toThrow("multiple results");
    expect(() => buildClosedTranscript({ messages: [result], target })).toThrow(
      "no matching call",
    );
  });
  test("drops legacy reasoning without guessing the signature issuer", () => {
    const drops: unknown[] = [];
    const closed = buildClosedTranscript({
      messages: [
        { ...call, thinking: [{ content: "private", signature: "opaque" }] },
      ],
      target,
      onReasoningDropped: (drop) => drops.push(drop),
    });
    expect(closed.at(0)?.thinking).toBeUndefined();
    expect(closed.at(0)?.toolCalls).toEqual(call.toolCalls);
    expect(drops).toEqual([
      {
        fromProvider: "unknown",
        toProvider: "openai",
        reason: "missing-provenance",
        count: 1,
      },
    ]);
  });
  const providers = ["openai", "anthropic", "google"] as const;
  for (const from of providers) {
    for (const to of providers) {
      test(`replay compatibility ${from} to ${to}`, () => {
        const fromModel = BYOK_MODEL_OPTIONS[from][0];
        const toModel = BYOK_MODEL_OPTIONS[to][0];
        const capabilities = getModelReasoningCapabilities(fromModel);
        const provenance = capabilities?.replayCompatibility.at(0);
        expect(provenance).toBeDefined();
        if (provenance === undefined) {
          throw new TypeError("Fixture needs a replayable model");
        }
        const thinking = {
          content: "reasoning",
          signature:
            from === "openai"
              ? JSON.stringify({ id: "rs_1", encrypted_content: "enc" })
              : "signature",
          provenance,
        };
        const messages = [
          { ...call, thinking: [thinking] },
          { role: "tool", toolCallId: "call-1", content: "saved" },
        ] satisfies ModelMessage[];
        const closed = buildClosedTranscript({
          messages,
          target: { provider: to, modelId: toModel },
          onReasoningDropped: () => undefined,
        });
        expect(closed.at(0)?.thinking).toEqual(
          from === to ? [thinking] : undefined,
        );
        expect(closed.at(0)?.content).toBe("Calling");
        expect(closed.at(0)?.toolCalls).toEqual(call.toolCalls);
        expect(closed.at(1)).toEqual(messages.at(1));
      });
    }
  }
  test("drops reasoning for a model with no replay capability", () => {
    const reasoning = {
      content: "reason",
      signature: "sig",
      provenance: {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        format: "anthropic-thinking-signature",
      },
    };
    const closed = buildClosedTranscript({
      messages: [{ ...call, thinking: [reasoning] }],
      target: { provider: "mistral", modelId: BYOK_MODEL_OPTIONS.mistral[0] },
      onReasoningDropped: () => undefined,
    });
    expect(closed.at(0)?.thinking).toBeUndefined();
    expect(closed.at(0)?.toolCalls).toEqual(call.toolCalls);
  });
  test("a same-provider model switch drops reasoning and its paired item id", () => {
    const thinking = {
      content: "reason",
      signature: JSON.stringify({ id: "rs_1", encrypted_content: "enc" }),
      provenance: {
        provider: "openai",
        model: "gpt-6-sol",
        format: "openai-encrypted-content",
      },
    };
    const calls = call.toolCalls.map((entry) => ({
      ...entry,
      metadata: { itemId: "fc_1", step: "step-1" },
    }));
    const result = {
      role: "tool",
      toolCallId: "call-1",
      content: "saved",
    } satisfies ModelMessage;
    const closed = buildClosedTranscript({
      messages: [{ ...call, toolCalls: calls, thinking: [thinking] }, result],
      target: { provider: "openai", modelId: "gpt-6.1-sol" },
      onReasoningDropped: () => undefined,
    });
    expect(closed.at(0)?.thinking).toBeUndefined();
    expect(closed.at(0)?.toolCalls).toEqual(
      call.toolCalls.map((entry) => ({
        ...entry,
        metadata: { step: "step-1" },
      })),
    );
    expect(closed.at(1)).toEqual(result);
  });
  test("id-only OpenAI reasoning cannot replay on a stateless request", () => {
    const thinking = {
      content: "reason",
      signature: JSON.stringify({ id: "rs_1" }),
      provenance: {
        provider: "openai",
        model: "gpt-6-sol",
        format: "openai-item-id",
      },
    };
    const closed = buildClosedTranscript({
      messages: [{ ...call, thinking: [thinking] }],
      target,
      onReasoningDropped: () => undefined,
    });
    expect(closed.at(0)?.thinking).toBeUndefined();
    expect(closed.at(0)?.toolCalls).toEqual(call.toolCalls);
  });
  test("drops a foreign Google signature without removing its tool call", () => {
    const calls = call.toolCalls.map((entry) => ({
      ...entry,
      metadata: {
        thoughtSignature: "google-signature",
        reasoningProvenance: {
          provider: "google",
          model: BYOK_MODEL_OPTIONS.google[0],
          format: "google-thought-signature",
        },
      },
    }));
    const closed = buildClosedTranscript({
      messages: [{ ...call, toolCalls: calls }],
      target,
      onReasoningDropped: () => undefined,
    });
    expect(closed.at(0)?.toolCalls?.at(0)?.metadata).toEqual({});
    expect(closed.at(0)?.toolCalls?.at(0)?.id).toBe("call-1");
    expect(closed.at(1)?.toolCallId).toBe("call-1");
  });
  test("aggregates replay drops by dimensions and does not recount a closed history", () => {
    const drops: unknown[] = [];
    const thinking = [
      { content: "Legacy first" },
      { content: "Legacy second" },
      {
        content: "Foreign reasoning",
        provenance: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          format: "anthropic-thinking-signature",
        },
      },
    ];
    const history = [
      {
        role: "assistant",
        content: "Historical answer",
        thinking,
      },
    ] satisfies ModelMessage[];
    const closed = buildClosedTranscript({
      messages: history,
      target,
      onReasoningDropped: (drop) => drops.push(drop),
    });
    expect(drops).toEqual([
      {
        fromProvider: "unknown",
        toProvider: "openai",
        reason: "missing-provenance",
        count: 2,
      },
      {
        fromProvider: "anthropic",
        toProvider: "openai",
        reason: "incompatible-provenance",
        count: 1,
      },
    ]);
    expect(closed.at(0)?.thinking).toBeUndefined();
    drops.length = 0;
    for (let request = 0; request < 3; request += 1) {
      expect(
        buildClosedTranscript({
          messages: structuredClone(closed),
          target,
          onReasoningDropped: (drop) => drops.push(drop),
        }),
      ).toEqual(closed);
    }
    expect(drops).toEqual([]);
  });
  test("counts unpaired reasoning in one grouped notification", () => {
    const thinking = ["rs_1", "rs_2"].map((id) => ({
      content: "Reasoning",
      signature: JSON.stringify({ id, encrypted_content: `encrypted-${id}` }),
      provenance: {
        provider: target.provider,
        model: target.modelId,
        format: "openai-encrypted-content",
      },
    }));
    const drops: unknown[] = [];
    const closed = buildClosedTranscript({
      messages: [{ ...call, thinking }],
      target,
      onReasoningDropped: (drop) => drops.push(drop),
    });
    expect(closed.at(0)?.thinking).toBeUndefined();
    expect(drops).toEqual([
      {
        fromProvider: "openai",
        toProvider: "openai",
        reason: "unpaired-reasoning",
        count: 2,
      },
    ]);
  });
});

describe("continuing a tool-use turn whose reasoning was not replayed", () => {
  const anthropic = {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  } as const;
  const result = {
    role: "tool",
    toolCallId: "call-1",
    content: JSON.stringify({ status: "completed" }),
  } satisfies ModelMessage;
  const decide = (
    messages: readonly ModelMessage[],
    decisionTarget: { provider: "anthropic" | "openai"; modelId: string },
    thinkingRequested = true,
  ) => {
    const drops: unknown[] = [];
    const transcript = buildClosedTranscript({
      messages,
      target: decisionTarget,
      onReasoningDropped: () => undefined,
    });
    const decision = continuationThinkingFor({
      transcript,
      target: decisionTarget,
      thinkingRequested,
      onReasoningDropped: (drop) => drops.push(drop),
    });
    return { decision, drops };
  };

  test("Anthropic thinking is disabled for that request, and the decision is counted", () => {
    const stored = {
      ...call,
      thinking: [{ content: "Stored", signature: "stored" }],
    } satisfies ModelMessage;
    expect(decide([stored, result], anthropic)).toEqual({
      decision: "disabled",
      drops: [
        {
          fromProvider: "unknown",
          toProvider: "anthropic",
          reason: "continuation-thinking-disabled",
          count: 1,
        },
      ],
    });
  });

  test("a turn whose own reasoning is replayed keeps thinking as requested", () => {
    const own = {
      ...call,
      thinking: [
        {
          content: "Own",
          signature: "own",
          provenance: {
            provider: "anthropic",
            model: anthropic.modelId,
            format: "anthropic-thinking-signature",
          },
        },
      ],
    };
    expect(decide([own, result], anthropic)).toEqual({
      decision: "as-requested",
      drops: [],
    });
  });

  test("other providers, unrequested thinking and answered turns keep the request as built", () => {
    expect(decide([call, result], target)).toEqual({
      decision: "as-requested",
      drops: [],
    });
    expect(decide([call, result], anthropic, false)).toEqual({
      decision: "as-requested",
      drops: [],
    });
    expect(
      decide(
        [call, result, { role: "user", content: "Next question" }],
        anthropic,
      ),
    ).toEqual({ decision: "as-requested", drops: [] });
  });
});
