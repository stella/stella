import { EventType, type StreamChunk, type Tool } from "@tanstack/ai";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

const normalizationCaseArbitrary = fc.record({
  requiredText: fc.string(),
  nestedRequiredText: fc.string(),
  optionalObjectPresent: fc.boolean(),
  rows: fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
});

test(
  "OpenAI and Mistral remove only provider-synthesized nulls across nested shapes",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        normalizationCaseArbitrary,
        async (normalizationCase) => {
          const providerInput = {
            requiredText: normalizationCase.requiredText,
            optionalText: null,
            nullableText: null,
            optionalObject: normalizationCase.optionalObjectPresent
              ? {
                  requiredText: normalizationCase.nestedRequiredText,
                  optionalText: null,
                  nullableText: null,
                }
              : null,
            rows: normalizationCase.rows.map((requiredText) => ({
              requiredText,
              optionalText: null,
              nullableText: null,
            })),
          };
          const expectedInput = {
            requiredText: normalizationCase.requiredText,
            nullableText: null,
            ...(normalizationCase.optionalObjectPresent
              ? {
                  optionalObject: {
                    requiredText: normalizationCase.nestedRequiredText,
                    nullableText: null,
                  },
                }
              : {}),
            rows: normalizationCase.rows.map((requiredText) => ({
              requiredText,
              nullableText: null,
            })),
          };

          expect(await streamOpenAiToolInput(providerInput)).toEqual(
            expectedInput,
          );
          expect(await streamMistralToolInput(providerInput)).toEqual(
            expectedInput,
          );
        },
      ),
      propertyConfig({ numRuns: 40 }),
    );
  },
  propertyTestTimeout(15_000),
);

const tool = {
  name: "normalize_nested_input",
  description: "Exercise nested strict-schema normalization.",
  inputSchema: {
    type: "object",
    properties: {
      requiredText: { type: "string" },
      optionalText: { type: "string" },
      nullableText: { type: ["string", "null"] },
      optionalObject: {
        type: "object",
        properties: {
          requiredText: { type: "string" },
          optionalText: { type: "string" },
          nullableText: { type: ["string", "null"] },
        },
        required: ["requiredText", "nullableText"],
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requiredText: { type: "string" },
            optionalText: { type: "string" },
            nullableText: { type: ["string", "null"] },
          },
          required: ["requiredText", "nullableText"],
        },
      },
    },
    required: ["requiredText", "nullableText", "rows"],
  },
} satisfies Tool;

const providerOptions = {
  logger: resolveDebugOption(false),
  messages: [{ role: "user" as const, content: "Normalize the input." }],
  tools: [tool],
};

const findToolInput = (chunks: StreamChunk[]): unknown =>
  chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END)?.input;

const streamOpenAiToolInput = async (input: unknown): Promise<unknown> => {
  const adapter = createOpenaiChat("gpt-5.2", "test-key");
  const argumentsJson = JSON.stringify(input);
  Reflect.set(adapter, "client", {
    responses: {
      create: () =>
        (async function* () {
          yield {
            type: "response.created",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "in_progress",
            },
          };
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "call-1",
              name: tool.name,
            },
          };
          yield {
            type: "response.function_call_arguments.delta",
            item_id: "call-1",
            delta: argumentsJson,
          };
          yield {
            type: "response.function_call_arguments.done",
            item_id: "call-1",
            arguments: argumentsJson,
          };
          yield {
            type: "response.completed",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "call-1",
                  name: tool.name,
                  arguments: argumentsJson,
                },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        })(),
    },
  });
  const chunks: StreamChunk[] = [];

  for await (const chunk of adapter.chatStream({
    ...providerOptions,
    model: adapter.model,
  })) {
    chunks.push(chunk);
  }

  return findToolInput(chunks);
};

const streamMistralToolInput = async (input: unknown): Promise<unknown> => {
  const adapter = createMistralText("mistral-large-latest", "test-key");
  const argumentsJson = JSON.stringify(input);
  Reflect.set(adapter, "fetchRawMistralStream", () =>
    (async function* () {
      yield {
        id: "response-1",
        model: "mistral-large-latest",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: {
                    name: tool.name,
                    arguments: argumentsJson,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        id: "response-1",
        model: "mistral-large-latest",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      };
    })(),
  );
  const chunks: StreamChunk[] = [];

  for await (const chunk of adapter.chatStream({
    ...providerOptions,
    model: adapter.model,
  })) {
    chunks.push(chunk);
  }

  return findToolInput(chunks);
};
