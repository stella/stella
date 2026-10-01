import { panic } from "better-result";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import type {
  AwsEventStreamMessage,
  ProviderWireCassette,
  ProviderWireExchange,
} from "@/api/tests/helpers/provider-wire-cassette";

// Each provider's recorded tool call answer, with and without the reasoning
// its model returns before the call, written in the provider's documented
// streaming format. The recordings are made without reasoning where the
// provider allows it (Gemini's carries a thought signature on the call), so
// the reasoning form is added here and the plain form strips it.

/** A signature only the provider that issued it could verify. */
const SIGNATURE =
  "EqQBCkgIBxABGAIqQJ4xY0b8m1Zl4wWqzXv7mT8rA3hQ0pN6bE5sK2cD9fU1gH7jL3oM5nP8qR2tV4wX6yZ0aB1cD2eF3gH4iJ5kL6m";
const REASONING_TEXT = "The user asked to delete the draft.";

type Answer = (cassette: ProviderWireCassette) => ProviderWireCassette;

const mapTextBodies = (
  cassette: ProviderWireCassette,
  rewrite: (text: string) => string,
): ProviderWireCassette => ({
  ...cassette,
  exchanges: cassette.exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding !== "text") {
      return panic(`${cassette.provider}'s answer is a text event stream`);
    }
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: { ...body, text: rewrite(body.text) },
      },
    };
  }),
});

/** Every `data:` line's JSON rewritten by `rewrite`. */
const mapDataEvents = (
  text: string,
  rewrite: (data: Record<string, unknown>) => Record<string, unknown>,
): string =>
  text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ")) {
        return line;
      }
      const raw = line.slice("data: ".length).replace(/\r$/u, "");
      if (raw === "[DONE]") {
        return line;
      }
      const parsed: unknown = JSON.parse(raw);
      const ending = line.endsWith("\r") ? "\r" : "";
      return isRecord(parsed)
        ? `data: ${JSON.stringify(rewrite(parsed))}${ending}`
        : line;
    })
    .join("\n");

/** Anthropic Messages API streaming, "extended thinking": a `thinking`
 *  content block, streamed as `thinking_delta` then `signature_delta`,
 *  before the tool use. */
const anthropicReasoning: Answer = (cassette) =>
  mapTextBodies(cassette, (text) => {
    const [start, ...rest] = text.split("\n\n");
    const thinking = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: REASONING_TEXT },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: SIGNATURE },
      },
      { type: "content_block_stop", index: 0 },
    ].map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}`);
    return [
      start ?? "",
      ...thinking,
      ...rest.map((event) => event.replaceAll('"index":0', () => '"index":1')),
    ].join("\n\n");
  });

/** OpenAI Responses API: a `reasoning` output item with its summary and
 *  `encrypted_content`, completed before the function call. */
const openAiReasoning: Answer = (cassette) =>
  mapTextBodies(cassette, (text) =>
    mapDataEvents(text, (data) => {
      const response = data["response"];
      if (data["type"] !== "response.completed" || !isRecord(response)) {
        return data;
      }
      const output = response["output"];
      return {
        ...data,
        response: {
          ...response,
          output: [
            {
              type: "reasoning",
              id: "rs_cassette_reasoning",
              encrypted_content: SIGNATURE,
              summary: [{ type: "summary_text", text: REASONING_TEXT }],
            },
            ...(isUnknownArray(output) ? output : []),
          ],
        },
      };
    }),
  );

type GeminiPart = Record<string, unknown>;

/** The first candidate's parts of a Gemini stream event, rewritten. */
const mapGeminiParts = (
  data: Record<string, unknown>,
  rewrite: (parts: readonly GeminiPart[]) => GeminiPart[],
): Record<string, unknown> => {
  const candidates = data["candidates"];
  const first = isUnknownArray(candidates) ? candidates[0] : undefined;
  const content = isRecord(first) ? first["content"] : undefined;
  const parts = isRecord(content) ? content["parts"] : undefined;
  if (!isUnknownArray(parts) || !isRecord(first) || !isRecord(content)) {
    return data;
  }
  return {
    ...data,
    candidates: [
      {
        ...first,
        content: { ...content, parts: rewrite(parts.filter(isRecord)) },
      },
      ...(isUnknownArray(candidates) ? candidates.slice(1) : []),
    ],
  };
};

const hasFunctionCall = (parts: readonly GeminiPart[]): boolean =>
  parts.some((part) => part["functionCall"] !== undefined);

/** Gemini generateContent: a thought part, and the call's thought
 *  signature (which the recording carries). */
const geminiReasoning: Answer = (cassette) =>
  mapTextBodies(cassette, (text) =>
    mapDataEvents(text, (data) =>
      mapGeminiParts(data, (parts) =>
        hasFunctionCall(parts)
          ? [{ text: REASONING_TEXT, thought: true }, ...parts]
          : [...parts],
      ),
    ),
  );

/** Gemini without reasoning: the call without its thought signature. */
const geminiPlain: Answer = (cassette) =>
  mapTextBodies(cassette, (text) =>
    mapDataEvents(text, (data) =>
      mapGeminiParts(data, (parts) =>
        parts.map((part) =>
          Object.fromEntries(
            Object.entries(part).filter(([key]) => key !== "thoughtSignature"),
          ),
        ),
      ),
    ),
  );

/** A chat completions chunk carrying `delta` before the first tool call. */
const withLeadingDelta = (
  text: string,
  delta: Record<string, unknown>,
): string => {
  const events = text.split("\n\n");
  const index = events.findIndex((event) => event.includes('"tool_calls"'));
  const template = events[index];
  if (template === undefined) {
    return panic("A tool call answer streams a tool call");
  }
  const line = template.split("\n").find((entry) => entry.startsWith("data: "));
  if (line === undefined) {
    return panic("A chat completions event is a data line");
  }
  const parsed: unknown = JSON.parse(line.slice("data: ".length));
  if (!isRecord(parsed)) {
    return panic("A chat completions chunk is an object");
  }
  const reasoningChunk = {
    ...parsed,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  return [
    ...events.slice(0, index),
    `data: ${JSON.stringify(reasoningChunk)}`,
    ...events.slice(index),
  ].join("\n\n");
};

/** Mistral chat completions (Magistral): a `thinking` content chunk. */
const mistralReasoning: Answer = (cassette) =>
  mapTextBodies(cassette, (text) =>
    withLeadingDelta(text, {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: [{ type: "text", text: REASONING_TEXT }],
        },
      ],
    }),
  );

/** OpenRouter chat completions: `reasoning_details` of type
 *  `reasoning.text`, as its reasoning tokens guide streams them. */
const openRouterReasoning: Answer = (cassette) =>
  mapTextBodies(cassette, (text) =>
    withLeadingDelta(text, {
      role: "assistant",
      content: null,
      reasoning: REASONING_TEXT,
      reasoning_details: [
        {
          type: "reasoning.text",
          text: REASONING_TEXT,
          format: "unknown",
          index: 0,
        },
      ],
    }),
  );

/** Bedrock ConverseStream: a `reasoningContent` text delta in its own
 *  content block, before the tool use. */
const bedrockReasoning: Answer = (cassette) => ({
  ...cassette,
  exchanges: cassette.exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding !== "aws-eventstream") {
      return panic("A Bedrock answer is an AWS event stream");
    }
    const event = (
      type: string,
      payload: Record<string, unknown>,
    ): AwsEventStreamMessage => ({
      headers: {
        ":content-type": "application/json",
        ":event-type": type,
        ":message-type": "event",
      },
      payload,
    });
    const shifted = body.messages.map((message) => {
      const { payload } = message;
      const index = isRecord(payload)
        ? payload["contentBlockIndex"]
        : undefined;
      return isRecord(payload) && typeof index === "number"
        ? { ...message, payload: { ...payload, contentBlockIndex: index + 1 } }
        : message;
    });
    const [start, ...rest] = shifted;
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          messages: [
            ...(start === undefined ? [] : [start]),
            event("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { reasoningContent: { text: REASONING_TEXT } },
            }),
            event("contentBlockStop", { contentBlockIndex: 0 }),
            ...rest,
          ],
        },
      },
    };
  }),
});

const unchanged: Answer = (cassette) => cassette;

/**
 * Per provider, its tool call answer without reasoning and with the
 * reasoning its model returns. Keyed by every provider, so a new one fails
 * typecheck here until both are written.
 */
export const REASONING_ANSWERS = {
  anthropic: { plain: unchanged, reasoning: anthropicReasoning },
  bedrock: { plain: unchanged, reasoning: bedrockReasoning },
  google: { plain: geminiPlain, reasoning: geminiReasoning },
  mistral: { plain: unchanged, reasoning: mistralReasoning },
  openai: { plain: unchanged, reasoning: openAiReasoning },
  openrouter: { plain: unchanged, reasoning: openRouterReasoning },
} as const satisfies Record<
  TanStackAIProvider,
  Record<"plain" | "reasoning", Answer>
>;

/** The usage keys each format reports the answer's output tokens under. */
const OUTPUT_TOKEN_KEYS: ReadonlySet<string> = new Set([
  "candidatesTokenCount",
  "completion_tokens",
  "outputTokens",
  "output_tokens",
]);

/** The keys each format streams the answer's text under: Anthropic's and
 *  Bedrock's `text`, OpenAI's `delta` and `text`, Gemini's part `text`, the
 *  chat completions `content`. */
const OUTPUT_TEXT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "delta",
  "text",
]);

/** `value` with its answer text blank and every output token count zero. */
const withoutOutput = (value: unknown): unknown => {
  if (isUnknownArray(value)) {
    return value.map(withoutOutput);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (OUTPUT_TOKEN_KEYS.has(key) && typeof child === "number") {
        return [key, 0];
      }
      if (OUTPUT_TEXT_KEYS.has(key) && typeof child === "string") {
        return [key, ""];
      }
      return [key, withoutOutput(child)];
    }),
  );
};

/**
 * `cassette`'s answer as a completion with nothing in it: it stops having
 * streamed no text and reports no output tokens, which the chat attempt
 * reads as an empty completion (by either measure) and answers with its
 * fallback model.
 */
export const emptyCompletionAnswer = (
  cassette: ProviderWireCassette,
): ProviderWireCassette => ({
  ...cassette,
  exchanges: cassette.exchanges.map((exchange): ProviderWireExchange => {
    const { body } = exchange.response;
    if (body.encoding === "text") {
      return {
        ...exchange,
        response: {
          ...exchange.response,
          body: {
            ...body,
            text: mapDataEvents(body.text, (data) => {
              const rewritten = withoutOutput(data);
              return isRecord(rewritten) ? rewritten : data;
            }),
          },
        },
      };
    }
    return {
      ...exchange,
      response: {
        ...exchange.response,
        body: {
          ...body,
          messages: body.messages.map((message) => {
            const payload = withoutOutput(message.payload);
            return isRecord(payload)
              ? { headers: message.headers, payload }
              : message;
          }),
        },
      },
    };
  }),
});
