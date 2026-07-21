import { EventType } from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ContentPart,
  ModelMessage,
  StreamChunk,
  TextPart,
  TokenUsage,
} from "@tanstack/ai";
import { panic } from "better-result";

import { isMockAI } from "@/api/consts";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import { registerBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";

// Dev/test-only preload: wired via the api `dev` script's `--preload`, never
// imported from `src/server.ts`. Registering the faker-backed mock generator here
// (rather than referencing it from the production handlers) keeps
// `generate-batch-mock` and `@faker-js/faker` out of the production build — both
// the compiled binary and the knip `--production` graph.

const MOCK_REPLY =
  "Mock assistant reply: streaming is stubbed because USE_MOCK_AI is set.";

// A user message containing this marker makes the mock adapter stream its
// reply as many small delayed chunks instead of one instant chunk, giving an
// e2e spec a real streaming window to hold open (e.g. to type into the
// composer while a response is still arriving).
const E2E_SLOW_STREAM_MARKER = "Stream slowly please";

const SLOW_STREAM_REPLY =
  "This mock reply streams back in many small pieces instead of arriving all " +
  "at once, so an end to end test has a real window while the assistant is " +
  "still responding. Each small piece lands only after a short delay, giving " +
  "the interface time to re-render before the whole message finally finishes " +
  "and the run completes for the test to inspect.";

// Word-ish deltas (each chunk keeps its trailing whitespace so the deltas
// concatenate back into SLOW_STREAM_REPLY exactly).
const SLOW_STREAM_CHUNKS = SLOW_STREAM_REPLY.match(/\S+\s*/gu) ?? [
  SLOW_STREAM_REPLY,
];

const SLOW_STREAM_CHUNK_DELAY_MS = 100;

const mockUsage: TokenUsage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const isTextPart = (part: ContentPart): part is TextPart =>
  part.type === "text";

// Adapter-facing messages carry either a plain string or a content-part array
// (see ModelMessage in @tanstack/ai); flatten either shape down to the text
// the marker check cares about.
const getLatestUserText = (messages: ModelMessage[]): string => {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );

  if (!latestUserMessage) {
    return "";
  }

  const { content } = latestUserMessage;
  if (typeof content === "string") {
    return content;
  }

  if (content === null) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (isTextPart(part)) {
      textParts.push(part.content);
    }
  }
  return textParts.join("");
};

const createMockTextAdapter = (modelId: string): AnyTextAdapter => ({
  kind: "text",
  name: "mock",
  model: modelId,
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ model, runId, threadId, messages }) {
    const resolvedRunId = runId ?? "mock-run";
    const resolvedThreadId = threadId ?? "mock-thread";
    const messageId = "mock-message";
    const timestamp = Date.now();
    const slowStream = getLatestUserText(messages).includes(
      E2E_SLOW_STREAM_MARKER,
    );

    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    } satisfies StreamChunk;

    if (slowStream) {
      for (const delta of SLOW_STREAM_CHUNKS) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          model,
          timestamp,
        } satisfies StreamChunk;
        // oxlint-disable-next-line no-await-in-loop -- sequential stream simulation: each chunk must land before the next delay starts, so an e2e spec sees a real streaming window
        await Bun.sleep(SLOW_STREAM_CHUNK_DELAY_MS);
      }
    } else {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: MOCK_REPLY,
        model,
        timestamp,
      } satisfies StreamChunk;
    }

    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
      finishReason: "stop",
      usage: mockUsage,
    } satisfies StreamChunk;
  },
  structuredOutput: async ({ outputSchema }) => {
    await Promise.resolve();
    const data = mockStructuredData(outputSchema);
    return {
      data,
      rawText: JSON.stringify(data),
      usage: mockUsage,
    };
  },
});

// Two playbook structured-output features have curated fixtures below because
// their semantic *values* matter (a grade, a derived question) beyond mere
// schema validity. Every other structured-output caller falls through to
// `synthesizeJsonSchemaObject`, which walks the JSON schema TanStack hands the
// adapter (already converted from the caller's Valibot schema, see
// `generateTanStackObjectForRole` in tanstack-ai-generate.ts) and builds the
// minimal value that satisfies it. Returning `{}` here previously passed
// schema validation to the caller's `v.parse`, which throws on any missing
// required field — every new structured-output feature was born broken
// under the documented `USE_MOCK_AI=true` dev default.
export const mockStructuredData = (
  outputSchema: unknown,
): Record<string, unknown> => {
  const properties = jsonSchemaProperties(outputSchema);

  // playbook.verdict — tier-match. Return a plain "deviation" with no `matched`
  // so the object is valid regardless of whether the prompt listed fallbacks.
  if ("tier" in properties) {
    return { tier: "deviation", rationale: "Mock verdict." };
  }

  // playbook.derive-ask — question + content type.
  if ("question" in properties && "contentType" in properties) {
    return {
      question: "What does the contract say about this issue?",
      contentType: "text",
    };
  }

  return synthesizeJsonSchemaObject(outputSchema);
};

const jsonSchemaProperties = (outputSchema: unknown): JsonSchemaNode => {
  if (
    !isJsonSchemaNode(outputSchema) ||
    !isJsonSchemaNode(outputSchema["properties"])
  ) {
    return {};
  }
  return outputSchema["properties"];
};

type JsonSchemaNode = Record<string, unknown>;

const isJsonSchemaNode = (value: unknown): value is JsonSchemaNode =>
  typeof value === "object" && value !== null;

// `Array.isArray` narrows an `unknown` argument to `any[]`, not `unknown[]`
// (a long-standing TypeScript lib.d.ts gap), which would otherwise leak `any`
// into every caller below.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

// A branch list (`anyOf`/`oneOf`) that contains an explicit `{ type: "null" }`
// member is how Valibot's `v.nullable()` reaches the mock: a genuinely
// nullable, still-required field. Synthesizing `null` is always valid for it.
const hasExplicitNullBranch = (node: JsonSchemaNode): boolean => {
  const branches = node["anyOf"] ?? node["oneOf"];
  if (!isUnknownArray(branches)) {
    return false;
  }
  return branches.some(
    (branch) => isJsonSchemaNode(branch) && isNullOnlyType(branch["type"]),
  );
};

const isNullOnlyType = (type: unknown): boolean =>
  type === "null" || (isUnknownArray(type) && type.every((t) => t === "null"));

// A field is nullable to the mock through either of two encodings, depending
// on which provider the pipeline projected the schema for before handing it
// over (the mock runs under whatever provider `resolveProvider` picks, which
// defaults to Google when `AI_PROVIDER` is unset): an OpenAI-style `anyOf`
// null branch, or a Google-style `nullable: true` flag
// (provider-safe-json-schema.ts lowers null unions to `nullable`). Real
// structured-output schemas make nullable members `required` rather than
// optional (OpenAI strict output rejects optional properties), so `null` is
// the correct minimal value — and, unlike the `"string"` primitive, it also
// satisfies a nullable field that carries a format constraint (e.g. an ISO
// date), which a mock string would fail.
const isNullable = (node: JsonSchemaNode): boolean =>
  hasExplicitNullBranch(node) || node["nullable"] === true;

// TanStack's `forStructuredOutput` conversion (`convertSchemaForStructuredOutput`,
// applied to every schema before an adapter's `structuredOutput` sees it)
// widens originally-optional properties into `required` entries whose `type`
// gains a `"null"` member (e.g. `"string"` -> `["string", "null"]`), tracked in
// a `nullWideningMap` the caller uses to undo the widening once the real
// provider replies. The mock never receives that map, so this is the only
// signal left that a property was optional in the original Valibot schema:
// unlike `v.nullable()` (an `anyOf`/`oneOf` null branch, see above), the
// widening mutates `type` in place. Detecting it lets the synthesized object
// omit the key, matching what the original schema actually requires.
const isWidenedOptional = (node: JsonSchemaNode): boolean => {
  const type = node["type"];
  if (!isUnknownArray(type) || !type.includes("null")) {
    return false;
  }
  return (
    type.some((t) => t !== "null") &&
    node["anyOf"] === undefined &&
    node["oneOf"] === undefined
  );
};

const primaryType = (type: unknown): string | undefined => {
  if (typeof type === "string") {
    return type;
  }
  if (isUnknownArray(type)) {
    return type.find((t): t is string => typeof t === "string" && t !== "null");
  }
  return undefined;
};

const synthesisFailure = (node: unknown): never =>
  panic(
    "mock AI adapter cannot synthesise structured output for this schema; " +
      `add a fixture in register-mock-ai.ts (schema node: ${JSON.stringify(node)})`,
  );

// Generic JSON-schema-shaped value synthesis: walks `outputSchema` and builds
// the minimal value that satisfies it, so any structured-output caller — not
// just the two curated playbook fixtures above — gets a schema-valid mock
// response instead of `{}`.
const synthesizeJsonSchemaValue = (node: unknown): unknown => {
  if (!isJsonSchemaNode(node)) {
    return synthesisFailure(node);
  }

  if ("const" in node) {
    return node["const"];
  }

  if (isUnknownArray(node["enum"]) && node["enum"].length > 0) {
    return node["enum"][0];
  }

  if (isNullable(node)) {
    return null;
  }

  switch (primaryType(node["type"])) {
    case "object":
      return synthesizeJsonSchemaObject(node);
    case "array":
      return synthesizeJsonSchemaArray(node);
    case "string":
      return "mock";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return synthesisFailure(node);
  }
};

const synthesizeJsonSchemaObject = (node: unknown): Record<string, unknown> => {
  if (!isJsonSchemaNode(node)) {
    return synthesisFailure(node);
  }

  const properties = isJsonSchemaNode(node["properties"])
    ? node["properties"]
    : {};
  const required = isUnknownArray(node["required"]) ? node["required"] : [];

  const result: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isJsonSchemaNode(propertySchema)) {
      continue;
    }
    if (isWidenedOptional(propertySchema)) {
      continue;
    }
    if (isNullable(propertySchema)) {
      result[key] = null;
      continue;
    }
    if (!required.includes(key)) {
      continue;
    }
    result[key] = synthesizeJsonSchemaValue(propertySchema);
  }
  return result;
};

const synthesizeJsonSchemaArray = (node: JsonSchemaNode): unknown[] => {
  const minItems = typeof node["minItems"] === "number" ? node["minItems"] : 0;
  if (minItems <= 0) {
    return [];
  }

  const itemsSchema = isUnknownArray(node["items"])
    ? node["items"].at(0)
    : node["items"];
  return Array.from({ length: minItems }, () =>
    synthesizeJsonSchemaValue(itemsSchema),
  );
};

if (isMockAI()) {
  registerBatchGenerator(generateBatchMock);
  registerTanStackMockTextAdapterFactory(createMockTextAdapter);
}
