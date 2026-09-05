import { EventType, convertSchemaToJsonSchema } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  MODEL_ROLES,
  REASONING_EFFORTS,
} from "@stll/ai-catalog";

import type { CachingDecision } from "@/api/lib/ai-config";
import { classifyAIError, isAnticipatedAIFailure } from "@/api/lib/ai-error";
import { toSafeId } from "@/api/lib/branded-types";
import { StructuredOutputBudgetError } from "@/api/lib/structured-output-budget";
import {
  generateTanStackObjectForRole,
  generateTanStackTextForRole,
  mergeGenerationOptions,
  streamTanStackObjectForRole,
  streamTanStackTextForRole,
} from "@/api/lib/tanstack-ai-generate";
import {
  type ResolvedTanStackTextModel,
  tanStackModelOptionsForRole,
} from "@/api/lib/tanstack-ai-models";
import {
  projectSchemaInputJsonSchema,
  toTanStackValibotSchema,
} from "@/api/lib/tanstack-ai-schema";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

// The real `chat()` engine runs here; only the provider boundary is faked.
// Replacing the engine instead lets a fixture invent public chunk shapes the
// engine never emits (it rewrites `RUN_FINISHED.finishReason` into
// `metadata.tanstack`), so a caller can stay green against a shape production
// never sees. Every fixture below is therefore a queued *provider* run,
// replayed through a plain `AnyTextAdapter`.

type TextRunFinish = "none" | "unreasoned" | "stop" | "length";

type ProviderRun =
  | {
      type: "text";
      deltas: string[];
      finish: TextRunFinish;
      /** Cancels the caller's signal once the provider stream is exhausted. */
      abortAfter?: AbortController | undefined;
    }
  | { type: "run-error"; code?: string | undefined; message: string }
  | { type: "throw"; error: unknown }
  | { type: "abort-then-throw"; controller: AbortController }
  | { type: "object"; object: unknown; raw: string };

type ProviderRequestMethod = "chatStream" | "structuredOutput";

type CapturedProviderRequest = {
  messages: unknown;
  method: ProviderRequestMethod;
  modelOptions: unknown;
  outputSchema: unknown;
  systemPrompts: unknown;
};

const providerRequests: CapturedProviderRequest[] = [];
const queuedRuns: ProviderRun[] = [];

const resetProvider = (): void => {
  providerRequests.length = 0;
  queuedRuns.length = 0;
};

const queueRun = (run: ProviderRun): void => {
  queuedRuns.push(run);
};

const takeRun = (): ProviderRun => {
  const run = queuedRuns.shift();
  if (!run) {
    throw new Error("Expected a queued provider run for this request.");
  }
  return run;
};

const textRun = (
  deltas: string[],
  finish: TextRunFinish = "none",
): ProviderRun => ({
  type: "text",
  deltas,
  finish,
});

// The provider stream ends and only then does the caller's signal fire: the
// chat loop leaves a cancelled run through a plain `break`, so the deltas
// already collected stand and nothing is thrown. A finish models the run
// reporting completion before the signal fires.
const cancelledTextRun = (
  deltas: string[],
  controller: AbortController,
  finish: TextRunFinish = "none",
): ProviderRun => ({ type: "text", deltas, finish, abortAfter: controller });

const abortRejectedRun = (controller: AbortController): ProviderRun => ({
  type: "abort-then-throw",
  controller,
});

// An adapter reports `code` only when its SDK exception exposes a structured
// body; leave it out to model the ones that stringify the body into the message.
const runErrorRun = ({
  code,
  message,
}: {
  code?: string | undefined;
  message: string;
}): ProviderRun => ({
  type: "run-error",
  ...(code === undefined ? {} : { code }),
  message,
});

const objectRun = (
  object: unknown,
  raw = JSON.stringify(object),
): ProviderRun => ({
  type: "object",
  object,
  raw,
});

const throwingRun = (error: unknown): ProviderRun => ({ type: "throw", error });

const PROVIDER_RUN_ID = "run-1";
const PROVIDER_THREAD_ID = "thread-1";
const PROVIDER_MESSAGE_ID = "provider-message-1";

const textRunChunks = async function* (
  run: Extract<ProviderRun, { type: "text" }>,
): AsyncIterable<StreamChunk> {
  yield {
    type: EventType.RUN_STARTED,
    runId: PROVIDER_RUN_ID,
    threadId: PROVIDER_THREAD_ID,
  } satisfies StreamChunk;
  yield {
    type: EventType.TEXT_MESSAGE_START,
    messageId: PROVIDER_MESSAGE_ID,
    role: "assistant",
  } satisfies StreamChunk;
  for (const delta of run.deltas) {
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: PROVIDER_MESSAGE_ID,
      delta,
    } satisfies StreamChunk;
  }
  yield {
    type: EventType.TEXT_MESSAGE_END,
    messageId: PROVIDER_MESSAGE_ID,
  } satisfies StreamChunk;

  switch (run.finish) {
    case "none":
      break;
    // `RUN_FINISHED` may carry no finish reason at all; the run still finished.
    case "unreasoned":
      yield {
        type: EventType.RUN_FINISHED,
        runId: PROVIDER_RUN_ID,
        threadId: PROVIDER_THREAD_ID,
      } satisfies StreamChunk;
      break;
    case "stop":
    case "length":
      yield {
        type: EventType.RUN_FINISHED,
        finishReason: run.finish,
        runId: PROVIDER_RUN_ID,
        threadId: PROVIDER_THREAD_ID,
      } satisfies StreamChunk;
      break;
    default:
      run.finish satisfies never;
      throw new TypeError(`Unhandled text run finish: ${String(run.finish)}`);
  }

  run.abortAfter?.abort();
};

const providerAdapter: AnyTextAdapter = {
  kind: "text",
  name: "queued",
  model: "test-model",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ messages, modelOptions, systemPrompts }) {
    providerRequests.push({
      messages,
      method: "chatStream",
      modelOptions,
      outputSchema: undefined,
      systemPrompts,
    });
    const run = takeRun();
    switch (run.type) {
      case "text":
        yield* textRunChunks(run);
        return;
      case "run-error":
        yield {
          type: EventType.RUN_STARTED,
          runId: PROVIDER_RUN_ID,
          threadId: PROVIDER_THREAD_ID,
        } satisfies StreamChunk;
        yield {
          type: EventType.RUN_ERROR,
          ...(run.code === undefined ? {} : { code: run.code }),
          message: run.message,
          runId: PROVIDER_RUN_ID,
          threadId: PROVIDER_THREAD_ID,
        } satisfies StreamChunk;
        return;
      case "abort-then-throw":
        run.controller.abort();
        throw run.controller.signal.reason;
      case "throw":
        throw run.error;
      case "object":
        throw new TypeError("A structured-output run was queued for text.");
      default:
        run satisfies never;
        throw new TypeError(`Unhandled provider run: ${String(run)}`);
    }
  },
  structuredOutput: async ({ chatOptions, outputSchema }) => {
    providerRequests.push({
      messages: chatOptions.messages,
      method: "structuredOutput",
      modelOptions: chatOptions.modelOptions,
      outputSchema,
      systemPrompts: chatOptions.systemPrompts,
    });
    const run = takeRun();
    switch (run.type) {
      case "object":
        return { data: run.object, rawText: run.raw };
      case "throw":
        throw run.error;
      case "text":
      case "run-error":
      case "abort-then-throw":
        throw new TypeError("A text run was queued for structured output.");
      default:
        run satisfies never;
        throw new TypeError(`Unhandled provider run: ${String(run)}`);
    }
  },
};

// SAFETY: `adapter` is a real `AnyTextAdapter` the engine drives exactly as it
// drives a provider; the remaining fields are bookkeeping this suite never
// routes through a provider.
const testModel = {
  adapter: providerAdapter,
  keySource: "instance",
  modelId: "test-model",
  modelOptions: {},
  provider: "openai",
} as ResolvedTanStackTextModel;

const resolveTextModel = () => testModel;
const generateTextForTestModel = async (
  options: Parameters<typeof generateTanStackTextForRole>[0],
) => await generateTanStackTextForRole({ ...options, resolveTextModel });
const generateObjectForTestModel = async <TSchema extends v.GenericSchema>(
  options: Parameters<typeof generateTanStackObjectForRole<TSchema>>[0],
) => await generateTanStackObjectForRole({ ...options, resolveTextModel });
const streamTextForTestModel = (
  options: Parameters<typeof streamTanStackTextForRole>[0],
) => streamTanStackTextForRole({ ...options, resolveTextModel });
const streamObjectForTestModel = <TSchema extends v.GenericSchema>(
  options: Parameters<typeof streamTanStackObjectForRole<TSchema>>[0],
) => streamTanStackObjectForRole({ ...options, resolveTextModel });

const noCaching = {
  enabled: false,
  reason: "org-disabled",
} satisfies CachingDecision;

let analytics: RecordingAnalytics;
let logs: RecordingLogger;

beforeEach(() => {
  resetProvider();
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
});

afterEach(() => {
  analytics.restore();
  logs.restore();
});

describe("TanStack AI structured output generation", () => {
  test("converts Valibot schemas into TanStack JSON-schema-compatible schemas", () => {
    const tanStackSchema = toTanStackValibotSchema(
      v.strictObject({ answer: v.string() }),
    );

    const jsonSchema = convertSchemaToJsonSchema(tanStackSchema);

    if (!jsonSchema) {
      throw new TypeError("Expected TanStack to convert the schema.");
    }
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("answer");
  });

  test("keeps trim normalization outside the provider JSON schema", () => {
    const rawSchema = v.strictObject({
      answer: v.pipe(v.string(), v.trim(), v.minLength(1)),
    });
    const tanStackSchema = toTanStackValibotSchema(rawSchema);

    const jsonSchema = convertSchemaToJsonSchema(tanStackSchema);

    if (!jsonSchema) {
      throw new TypeError("Expected TanStack to convert the schema.");
    }
    expect(jsonSchema.properties?.["answer"]).toEqual({
      minLength: 1,
      type: "string",
    });
    expect(v.parse(rawSchema, { answer: "  normalized  " })).toEqual({
      answer: "normalized",
    });
  });

  test("still rejects unsupported output transformations", () => {
    const tanStackSchema = toTanStackValibotSchema(
      v.pipe(v.string(), v.toLowerCase()),
    );

    expect(() => convertSchemaToJsonSchema(tanStackSchema)).toThrow(
      'The "to_lower_case" action cannot be converted to JSON Schema.',
    );
  });

  test("rejects unknown JSON Schema targets instead of silently changing drafts", () => {
    const tanStackSchema = toTanStackValibotSchema(v.string());

    expect(() =>
      tanStackSchema["~standard"].jsonSchema.input({
        target: "future-draft",
      }),
    ).toThrow("Unsupported JSON Schema target: future-draft");
  });

  test("projects plain JSON schemas even when they contain a standard-looking key", () => {
    const schema = projectSchemaInputJsonSchema(
      {
        type: "object",
        "~standard": {},
        propertyNames: { type: "string" },
        properties: {
          mode: { enum: ["auto", null] },
        },
      },
      { nullUnionStrategy: "openapi" },
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        mode: { enum: ["auto"], nullable: true },
      },
    });
  });

  test("passes converted Valibot schemas to TanStack object generation", async () => {
    queueRun(objectRun({ answer: "ok" }));
    const rawSchema = v.strictObject({ answer: v.string() });

    const result = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    });

    expect(result).toEqual({ answer: "ok" });
    // The engine converts the Standard Schema before the provider sees it, so
    // conversion is asserted on the JSON Schema the provider is handed rather
    // than on the wrapper handed to `chat()`.
    const captured = onlyProviderRequest();
    expect(captured.method).toBe("structuredOutput");
    expect(captured.outputSchema).not.toBe(rawSchema);
    expectProviderJsonSchema(captured.outputSchema);
  });

  test("passes converted Valibot schemas to TanStack streaming object generation", async () => {
    const rawSchema = v.strictObject({ answer: v.string() });
    queueRun(objectRun({ answer: "ok" }, '{"answer":"ok"}'));

    const events = [];
    for await (const event of streamObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    })) {
      events.push(event);
    }

    // Streaming is not visible at the provider boundary (both structured paths
    // land on `structuredOutput`); the caller-visible partial/complete pair is
    // what only the streaming path produces, so it carries that assertion.
    expect(events).toEqual([
      {
        delta: '{"answer":"ok"}',
        partial: { answer: "ok" },
        raw: '{"answer":"ok"}',
        type: "partial",
      },
      {
        object: { answer: "ok" },
        raw: '{"answer":"ok"}',
        type: "complete",
      },
    ]);
    const captured = onlyProviderRequest();
    expect(captured.outputSchema).not.toBe(rawSchema);
    expectProviderJsonSchema(captured.outputSchema);
  });

  // The test model is an OpenAI one, so the schema has to clear the widest
  // budget in the table. Every provider's budget is enforced at the same seam.
  const overBudgetSchema = () =>
    v.strictObject(
      Object.fromEntries(
        Array.from({ length: 600 }, (_, index) => [
          `field_${index}`,
          v.pipe(
            v.string(),
            v.description(
              `Field ${index}: ${"a long instruction repeated to inflate the projected schema. ".repeat(3)}`,
            ),
          ),
        ]),
      ),
    );

  test("refuses an over-budget structured-output schema before it reaches the provider", async () => {
    const failure = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: overBudgetSchema(),
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StructuredOutputBudgetError);
    expect(String(failure)).toContain("exceeds the openai budget");
    expect(providerRequests).toHaveLength(0);
  });

  test("refuses an over-budget structured-output schema before it starts streaming", async () => {
    const events: unknown[] = [];
    const drain = async () => {
      for await (const event of streamObjectForTestModel({
        caching: noCaching,
        organizationId: null,
        orgAIConfig: null,
        outputSchema: overBudgetSchema(),
        prompt: "Extract the answer.",
        role: "pdf",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      })) {
        events.push(event);
      }
    };

    const failure = await drain().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StructuredOutputBudgetError);
    expect(String(failure)).toContain("exceeds the openai budget");
    expect(events).toEqual([]);
    expect(providerRequests).toHaveLength(0);
  });

  test("validates final objects with the original Valibot schema", async () => {
    queueRun(objectRun({ answer: 123 }));

    const validationFailure = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(validationFailure).toBeDefined();
  });

  test("keeps call-site temperature out of fixed-sampling Anthropic requests", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-opus-4-8",
      modelOptions: {},
      provider: "anthropic",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: 1000,
      model,
      serviceTier: "standard",
      temperature: 0,
    });

    expect(options).toEqual({ max_tokens: 1000 });
  });

  test("keeps call-site temperature out of Anthropic thinking requests", () => {
    // Anthropic extended thinking rejects temperature modifications
    // even on models that accept temperature otherwise
    // (claude-sonnet-4-6). The builder deliberately omits temperature
    // for the reasoning role, and the merge must not re-add the
    // caller's value on top of `thinking`.
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-sonnet-4-6",
      modelOptions: { thinking: { type: "adaptive" } },
      provider: "anthropic",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: 1000,
      model,
      serviceTier: "standard",
      temperature: 0,
    });

    expect(options).toEqual({
      max_tokens: 1000,
      thinking: { type: "adaptive" },
    });
  });

  test("reserves the Anthropic thinking budget on top of the output allowance", () => {
    // The budget form spends reasoning and visible output from one
    // `max_tokens`, and `budget_tokens` must stay below it. The caller's
    // allowance sizes the reply alone, so the reservation is added to it:
    // forwarding the allowance on its own both starves the reply and, below
    // the budget, describes a request Anthropic cannot serve.
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-haiku-4-5-20251001",
      modelOptions: { thinking: { type: "enabled", budget_tokens: 10_000 } },
      provider: "anthropic",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: 1800,
      model,
      serviceTier: "standard",
      temperature: undefined,
    });

    expect(options).toEqual({
      max_tokens: 11_800,
      thinking: { type: "enabled", budget_tokens: 10_000 },
    });
  });

  test("enables OpenAI prompt caching without sending a model-specific retention value", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge regression test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "gpt-5.5",
      modelOptions: {},
      provider: "openai",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: {
        enabled: true,
        scopeKey: "organization:contract-probe",
        ttl: "5m",
      },
      maxOutputTokens: 1000,
      model,
      serviceTier: "standard",
      temperature: 0,
    });

    expect(options).toEqual({
      max_output_tokens: 1000,
      prompt_cache_key:
        "106a444562569784437b331c30f0edcfa70367d5e744cdba050d7234d6ee197c",
      service_tier: "default",
    });
    // gpt-5.5 rejects sampling overrides; the caller temperature
    // is suppressed by the capability gate.
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("prompt_cache_retention");
  });

  test("maps OpenRouter controls to the Chat Completions request shape", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge regression test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "google/gemini-3.5-flash",
      modelOptions: { temperature: 0 },
      provider: "openrouter",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: {
        enabled: true,
        scopeKey: "organization:contract-probe",
        ttl: "5m",
      },
      maxOutputTokens: 1000,
      model,
      serviceTier: "flex",
      temperature: 0,
    });

    expect(options).toEqual({
      maxCompletionTokens: 1000,
      serviceTier: "flex",
      temperature: 0,
    });
    expect(options).not.toHaveProperty("maxOutputTokens");
    expect(options).not.toHaveProperty("promptCacheKey");
    expect(options).not.toHaveProperty("sessionId");
  });

  test("forwards deferred service tiers to Gemini requests", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      // A catalogued id: caller temperature only survives the
      // capability gate for models with declared support.
      modelId: "gemini-3.1-pro-preview",
      modelOptions: { temperature: 0 },
      provider: "google",
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: 1000,
      model,
      serviceTier: "batch",
      temperature: 0,
    });

    expect(options).toEqual({
      maxOutputTokens: 1000,
      serviceTier: "flex",
      temperature: 0,
    });
  });

  // `chat({ outputSchema })` wraps the adapter's error (`new Error(message,
  // { cause: providerError })`), so the retry predicate has to read the status
  // one `cause` down. The engine mock this suite used to install returned the
  // provider error unwrapped, which hid the dead fallback.
  test("retries a deferred OpenAI object generation the engine wrapped with the standard tier", async () => {
    const apiError = Object.assign(new Error("OpenAI flex tier unavailable"), {
      isRetryable: true,
      statusCode: 429,
    });
    queueRun(throwingRun(apiError));
    queueRun(objectRun({ answer: "ok" }));

    const result = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "chat",
      serviceTier: "flex",
      tenantWorkspaceIds: [],
    });

    expect(result).toEqual({ answer: "ok" });
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[0]?.modelOptions).toMatchObject({
      service_tier: "flex",
    });
    expect(providerRequests[1]?.modelOptions).toMatchObject({
      service_tier: "default",
    });
  });

  test("does not retry non-retryable deferred OpenAI generation errors", async () => {
    const apiError = Object.assign(new Error("OpenAI request rejected"), {
      isRetryable: false,
      statusCode: 400,
    });
    queueRun(throwingRun(apiError));

    const caught = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "chat",
      serviceTier: "flex",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The engine hands the caller a wrapper, so the provider's own error is
    // reachable through `cause` rather than by identity.
    expect(caught).toHaveProperty("cause", apiError);
    expect(providerRequests).toHaveLength(1);
  });

  test("retries deferred structured streams after control-only chunks", async () => {
    queueRun(
      throwingRun(
        Object.assign(new Error("OpenAI flex tier unavailable"), {
          isRetryable: true,
          statusCode: 429,
        }),
      ),
    );
    queueRun(objectRun({ answer: "ok" }, '{"answer":"ok"}'));

    const events = [];
    for await (const event of streamObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "flex",
      tenantWorkspaceIds: [],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        delta: '{"answer":"ok"}',
        partial: { answer: "ok" },
        raw: '{"answer":"ok"}',
        type: "partial",
      },
      {
        object: { answer: "ok" },
        raw: '{"answer":"ok"}',
        type: "complete",
      },
    ]);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[0]?.modelOptions).toMatchObject({
      service_tier: "flex",
    });
    expect(providerRequests[1]?.modelOptions).toMatchObject({
      service_tier: "default",
    });
  });
});

// Every non-chat model call in the API dispatches through this module, so the
// guard has to run here rather than at each of the ~25 call sites. These pin
// the wiring against the real guard: the fake adapter records exactly what a
// provider would have received.
describe("TanStack AI model-ingress guard", () => {
  const tenantWorkspaceId = toSafeId<"workspace">(
    "0dc54d0c-10d7-501d-897e-e801dbd0998c",
  );
  const publicDecisionId = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";

  test("redacts tenant ids out of the dispatched messages", async () => {
    queueRun(textRun(["ok"]));

    await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: `Summarize https://my.stll.app/workspaces/${tenantWorkspaceId}/matters and decision ${publicDecisionId}`,
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    const dispatched = JSON.stringify(onlyProviderRequest().messages);
    expect(dispatched).not.toContain(tenantWorkspaceId);
    expect(dispatched).toContain("[internal-id-removed]");
    // Membership-exact: a public decision id is not a tenant id.
    expect(dispatched).toContain(publicDecisionId);
    // Routine redaction hits log; only server-built surfaces still capture.
    expect(analytics.exceptions()).toEqual([]);
    expect(
      logs.at("WARN").map((record) => ({
        message: record.message,
        surface: record.attributes?.["surface"],
      })),
    ).toEqual([
      { message: "chat.model_ingress_redacted", surface: "messages" },
    ]);
  });

  test("leaves a request without tenant ids untouched and silent", async () => {
    queueRun(textRun(["ok"]));

    await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: `Summarize decision ${publicDecisionId}`,
      role: "chat",
      serviceTier: "standard",
      system: "You are stella.",
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    const captured = onlyProviderRequest();
    expect(JSON.stringify(captured.messages)).toContain(publicDecisionId);
    expect(JSON.stringify(captured.messages)).not.toContain(
      "[internal-id-removed]",
    );
    expect(captured.systemPrompts).toEqual(["You are stella."]);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([]);
  });

  test("redacts an untrusted-embedding system prompt, fails closed on a server-built one", async () => {
    queueRun(textRun(["ok"]));

    await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Draft it.",
      role: "chat",
      serviceTier: "standard",
      system: `Document context: workspace ${tenantWorkspaceId}`,
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    expect(onlyProviderRequest().systemPrompts).toEqual([
      "Document context: workspace [internal-id-removed]",
    ]);
    // Routine redaction hits log; only server-built surfaces still capture.
    expect(analytics.exceptions()).toEqual([]);
    expect(
      logs.at("WARN").map((record) => ({
        message: record.message,
        surface: record.attributes?.["surface"],
      })),
    ).toEqual([
      {
        message: "chat.model_ingress_redacted",
        surface: "system-prompt-mixed",
      },
    ]);

    resetProvider();
    queueRun(textRun(["ok"]));
    const serverBuiltFailure = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Draft it.",
      role: "chat",
      serviceTier: "standard",
      system: `Server scaffold naming ${tenantWorkspaceId}`,
      systemPromptOrigin: "server-built",
      tenantWorkspaceIds: [tenantWorkspaceId],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Fail closed: the request never reached the provider.
    expect(serverBuiltFailure).toBeDefined();
    expect(providerRequests).toHaveLength(0);
    // A server-built surface embedding a tenant id is a defect, so it is
    // captured under the guard's source rather than only logged.
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      {
        "error.class": "TelemetryError",
        source: "model-ingress-guard",
        surface: "system-prompt",
      },
    ]);
  });
});

describe("TanStack AI text generation", () => {
  test("rejects incomplete output when complete generation is required", async () => {
    queueRun(textRun(["partial"], "length"));

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "require-complete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Rewrite it.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
  });

  test("rejects a cancelled run instead of returning its truncated text", async () => {
    const controller = new AbortController();
    queueRun(cancelledTextRun(["half an ans"], controller));

    const caught = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Rewrite it.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    // The 502 is what the caller answers with; the cause is what keeps a
    // failure sink from grading a caller-requested cancellation as a defect.
    expect(isAnticipatedAIFailure(caught, classifyAIError(caught))).toBe(true);
  });

  test("classifies an abort rejection from a cancelled run as anticipated", async () => {
    const controller = new AbortController();
    queueRun(abortRejectedRun(controller));

    const caught = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Rewrite it.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(isAnticipatedAIFailure(caught, classifyAIError(caught))).toBe(true);
  });

  test("keeps the output of a run that finished before the cancellation", async () => {
    const controller = new AbortController();
    queueRun(cancelledTextRun(["a whole answer"], controller, "stop"));

    const output = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Rewrite it.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    });

    expect(output).toBe("a whole answer");
  });

  test("keeps the output of a run that finished without a reason before the cancellation", async () => {
    const controller = new AbortController();
    queueRun(cancelledTextRun(["a whole answer"], controller, "unreasoned"));

    const output = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Rewrite it.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    });

    expect(output).toBe("a whole answer");
  });

  test("collects text through the error-aware streaming boundary", async () => {
    queueRun(textRun(["hello", " world"]));

    const output = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    });

    expect(output).toBe("hello world");
    // Collected text still comes off a streamed provider run: the engine
    // reaches the adapter through `chatStream`, never a blocking call.
    expect(onlyProviderRequest().method).toBe("chatStream");
  });

  test("propagates provider run errors from collected text", async () => {
    queueRun(
      runErrorRun({
        code: "invalid_request_error",
        message: "OpenAI rejected the request.",
      }),
    );

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({
      code: "invalid_request_error",
      message: "OpenAI rejected the request.",
      status: 502,
    });
  });

  test("classifies provider statuses after the run-error boundary", async () => {
    queueRun(
      runErrorRun({ code: "429", message: "OpenAI rate limit exceeded." }),
    );

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ code: "429", status: 502 });
    expect(classifyAIError(caught)).toBe("quota_exhausted");
  });

  // An adapter whose SDK exception stringifies the response body into the
  // message reports the run error with no `code` and no `rawEvent`. The body is
  // then the only evidence of what the provider answered, so the wrap has to
  // keep it: without it quota, billing, retired model and outage all read as
  // one unnamed transport failure.
  test("classifies a run error whose only detail is the provider body", async () => {
    queueRun(
      runErrorRun({
        message: JSON.stringify({
          error: {
            code: 429,
            message: "Resource has been exhausted.",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
      }),
    );

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(classifyAIError(caught)).toBe("quota_exhausted");
  });

  test("leaves a plain-text run error unclassified", async () => {
    queueRun(runErrorRun({ message: "The model is currently overloaded." }));

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(classifyAIError(caught)).toBe("unknown");
  });

  test("propagates provider run errors from streaming text", async () => {
    queueRun(
      runErrorRun({
        code: "rate_limit_exceeded",
        message: "OpenAI rate limit exceeded.",
      }),
    );

    const consume = async (): Promise<void> => {
      for await (const _delta of streamTextForTestModel({
        caching: noCaching,
        organizationId: null,
        orgAIConfig: null,
        prompt: "Say hello.",
        role: "chat",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      })) {
        // Consume the full stream so terminal provider events are observed.
      }
    };
    const caught = await consume().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({
      code: "rate_limit_exceeded",
      message: "OpenAI rate limit exceeded.",
      status: 502,
    });
  });
});

describe("Anthropic extended-thinking budgets", () => {
  // Two modules decide the halves of one constraint: the role builder picks
  // `thinking.budget_tokens`, the merge picks `max_tokens`, and a budget that
  // reaches `max_tokens` describes a request Anthropic cannot serve. Walking
  // every offered model, role, and effort binds them, so a model added to the
  // budget form cannot drift back past the smallest allowance a caller asks
  // for.
  const SMALLEST_CALLER_ALLOWANCE = 1;

  test("keeps every emitted budget under the merged max_tokens", () => {
    for (const modelId of BYOK_MODEL_OPTIONS.anthropic) {
      for (const role of MODEL_ROLES) {
        for (const reasoningEffort of [undefined, ...REASONING_EFFORTS]) {
          const modelOptions = tanStackModelOptionsForRole({
            modelId,
            organizationId: null,
            provider: "anthropic",
            reasoningEffort,
            role,
          });
          // SAFETY: mergeGenerationOptions only reads
          // provider/modelOptions/modelId. The adapter is irrelevant for this
          // pure option-merge invariant.
          // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
          const model = {
            adapter: {},
            keySource: "byok",
            modelId,
            modelOptions,
            provider: "anthropic",
          } as ResolvedTanStackTextModel;

          const merged: Record<string, unknown> = {
            ...mergeGenerationOptions({
              caching: noCaching,
              maxOutputTokens: SMALLEST_CALLER_ALLOWANCE,
              model,
              serviceTier: "standard",
              temperature: undefined,
            }),
          };

          let budget = 0;
          if (modelOptions.thinking?.type === "enabled") {
            const currentThinking: object = modelOptions.thinking;
            if (
              !("budget_tokens" in currentThinking) ||
              typeof currentThinking["budget_tokens"] !== "number"
            ) {
              throw new TypeError(
                "Expected enabled Anthropic thinking to carry a token budget",
              );
            }
            budget = currentThinking["budget_tokens"];
          }
          expect(merged["max_tokens"]).toBeGreaterThan(budget);
        }
      }
    }
  });
});

const onlyProviderRequest = (): CapturedProviderRequest => {
  const captured = providerRequests.at(0);
  if (!captured || providerRequests.length !== 1) {
    throw new Error("Expected exactly one provider request.");
  }
  return captured;
};

const expectProviderJsonSchema = (schema: unknown): void => {
  if (!isRecord(schema)) {
    throw new TypeError("Expected the provider to receive a JSON Schema.");
  }
  expect(schema["type"]).toBe("object");
  expect(schema["properties"]).toHaveProperty("answer");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
