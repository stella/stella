import { convertSchemaToJsonSchema, EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { Panic, TaggedError, UnhandledException } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  getOutputTokenLimit,
  MODEL_TASKS,
  REASONING_EFFORTS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import type { CachingDecision, OrgAIConfig } from "@/api/lib/ai-config";
import { classifyAIError, isAnticipatedAIFailure } from "@/api/lib/ai-error";
import type { AIErrorKind } from "@/api/lib/ai-error";
import { toSafeId } from "@/api/lib/branded-types";
import {
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  managedProviderUnavailable,
} from "@/api/lib/chat/provider-data-policy";
import {
  MODEL_OUTPUT_INCOMPLETE_MESSAGE,
  MODEL_RUN_ERROR_MESSAGE,
  ModelDeadlineExceededError,
  ModelOutputIncompleteError,
  ModelOutputInvalidError,
  ModelRunError,
  PROVIDER_CALL_ERROR_MESSAGE,
  PROVIDER_ERROR_CODE,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  admitModelDispatch,
  NO_ORGANIZATION_MODEL_DISPATCH,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import { StructuredOutputBudgetError } from "@/api/lib/structured-output-budget";
import {
  chatTurnOutputTokens,
  generateTanStackObjectForTask,
  generateTanStackTextForTask,
  mergeGenerationOptions,
  outputTokensWithinModelLimit,
  streamTanStackChatRun,
  streamTanStackObjectForTask,
  streamTanStackTextForTask,
  systemPromptsPatch,
  withRecoveredProviderStatus,
} from "@/api/lib/tanstack-ai-generate";
import {
  type ResolvedTanStackTextModel,
  tanStackModelOptionsForTask,
} from "@/api/lib/tanstack-ai-models";
import {
  projectSchemaInputJsonSchema,
  toTanStackValibotSchema,
} from "@/api/lib/tanstack-ai-schema";
import { testOrganizationStateDb } from "@/api/tests/helpers/model-dispatch-admission";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testState = createTestState({ file: import.meta.path, config: env });
testState.setConfig("OPENROUTER_API_KEY", "test-openrouter-instance-key");

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
  | {
      type: "run-error";
      code?: string | undefined;
      /** Text the run emitted before the error, as a ceiling stop does. */
      deltas?: string[] | undefined;
      message: string;
    }
  | { type: "throw"; error: unknown }
  | { type: "abort-then-throw"; controller: AbortController }
  | {
      type: "object";
      object: unknown;
      raw: string;
      /** Cancels the caller's signal before the provider answers. */
      abortBefore?: AbortController | undefined;
    };

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
  deltas,
  message,
}: {
  code?: string | undefined;
  deltas?: string[] | undefined;
  message: string;
}): ProviderRun => ({
  type: "run-error",
  ...(code === undefined ? {} : { code }),
  ...(deltas === undefined ? {} : { deltas }),
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

// The provider answers, but the caller's signal fired while it worked: the
// chat loop drops the answer and ends the run without an error of its own.
const cancelledObjectRun = (
  object: unknown,
  controller: AbortController,
): ProviderRun => ({
  type: "object",
  object,
  raw: JSON.stringify(object),
  abortBefore: controller,
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
        if (run.deltas) {
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
        }
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
        run.abortBefore?.abort();
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
  options: Parameters<typeof generateTanStackTextForTask>[0],
) => await generateTanStackTextForTask({ ...options, resolveTextModel });
const generateObjectForTestModel = async <TSchema extends v.GenericSchema>(
  options: Parameters<typeof generateTanStackObjectForTask<TSchema>>[0],
) => await generateTanStackObjectForTask({ ...options, resolveTextModel });
const streamTextForTestModel = (
  options: Parameters<typeof streamTanStackTextForTask>[0],
) => streamTanStackTextForTask({ ...options, resolveTextModel });
const streamObjectForTestModel = <TSchema extends v.GenericSchema>(
  options: Parameters<typeof streamTanStackObjectForTask<TSchema>>[0],
) => streamTanStackObjectForTask({ ...options, resolveTextModel });

const noCaching = {
  enabled: false,
  reason: "org-disabled",
} satisfies CachingDecision;

/** A sink with no local expectations, so a grade is the failure's own. */
const anySink = failureSink({ event: "generation.test", expected: [] });

/**
 * A provider answer whose only surviving detail is its response body: the
 * adapter reported the status as a plain field on its SDK exception and
 * stringified the body into the message, and the engine rebuilt the run error
 * from the message alone.
 */
const providerBodyError = (status: number): Error =>
  new Error(
    JSON.stringify({
      error: {
        code: status,
        message: `The provider answered ${status}.`,
      },
    }),
  );

// The statuses a body-only failure can name, and whether each justifies a
// second attempt on the standard tier. A permanent answer (rejected
// credentials, the upstream account's billing, a model the provider retired)
// says the same thing however it is asked, so re-asking only costs a request.
const PROVIDER_BODY_SERVICE_TIER_FALLBACK_MATRIX = [
  {
    kind: "provider_credentials_rejected",
    retriesOnStandardTier: false,
    status: 401,
  },
  { kind: "provider_billing", retriesOnStandardTier: false, status: 402 },
  { kind: "model_unavailable", retriesOnStandardTier: false, status: 404 },
  { kind: "quota_exhausted", retriesOnStandardTier: true, status: 429 },
  { kind: "provider_unavailable", retriesOnStandardTier: true, status: 500 },
  { kind: "provider_unavailable", retriesOnStandardTier: true, status: 503 },
] as const satisfies readonly {
  kind: AIErrorKind;
  retriesOnStandardTier: boolean;
  status: number;
}[];

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
  for (const path of [
    "text",
    "object",
    "text-stream",
    "object-stream",
  ] as const) {
    test(`preserves configured provider availability on ${path}`, async () => {
      const refusal = managedProviderUnavailable("openrouter");
      const objectPath = path === "object" || path === "object-stream";
      queueRun(
        objectPath
          ? throwingRun(refusal)
          : runErrorRun({
              code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
              message: refusal.message,
            }),
      );
      queueRun(
        objectPath ? objectRun({ answer: "ok" }) : textRun(["ok"], "stop"),
      );
      const options = {
        caching: noCaching,
        finishPolicy: "require-complete" as const,
        organizationId: null,
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer" as const,
        managedAIResidency: "eu" as const,
        orgAIConfig: null,
        prompt: "Reply with the answer.",
        task: "chat" as const,
        serviceTier: "flex" as const,
        tenantWorkspaceIds: [],
      };
      const outputSchema = v.strictObject({ answer: v.string() });
      const caught = await (async () => {
        switch (path) {
          case "text":
            await generateTextForTestModel(options);
            return;
          case "object":
            await generateObjectForTestModel({
              ...options,
              outputSchema,
            });
            return;
          case "text-stream":
            for await (const _chunk of streamTextForTestModel(options)) {
              /* consume stream */
            }
            return;
          case "object-stream":
            for await (const _chunk of streamObjectForTestModel({
              ...options,
              outputSchema,
            })) {
              /* consume stream */
            }
            return;
          default:
            path satisfies never;
            return;
        }
      })().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toMatchObject({
        status: 503,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        message: PROVIDER_CALL_ERROR_MESSAGE,
      });
      expect(classifyAIError(caught)).toBe("model_unavailable");
      expect(providerRequests).toHaveLength(1);
    });
  }

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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      task: "pdf",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      task: "pdf",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: overBudgetSchema(),
      prompt: "Extract the answer.",
      task: "pdf",
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
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer",
        managedAIResidency: "eu",
        orgAIConfig: null,
        outputSchema: overBudgetSchema(),
        prompt: "Extract the answer.",
        task: "pdf",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "pdf",
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
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-opus-4-8",
      modelOptions: {},
      provider: "anthropic",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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
    // for the reasoning task, and the merge must not re-add the
    // caller's value on top of `thinking`.
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-sonnet-4-6",
      modelOptions: { thinking: { type: "adaptive" } },
      provider: "anthropic",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-haiku-4-5-20251001",
      modelOptions: { thinking: { type: "enabled", budget_tokens: 10_000 } },
      provider: "anthropic",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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

  test("keeps a chat turn's whole Anthropic request within the model's output limit", () => {
    // SAFETY: the helpers read only provider/modelOptions/modelId.
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-haiku-4-5-20251001",
      modelOptions: { thinking: { type: "enabled", budget_tokens: 10_000 } },
      provider: "anthropic",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: chatTurnOutputTokens(model),
      model,
      serviceTier: "standard",
      temperature: undefined,
    });

    const limit = getOutputTokenLimit(model.modelId) ?? 0;
    // The fixture must reach the fault: a listed model whose limit exceeds
    // the thinking budget, so the reservation is taken out of it.
    expect(limit).toBeGreaterThan(10_000);
    expect(chatTurnOutputTokens(model)).toBe(limit - 10_000);
    expect(options).toMatchObject({ max_tokens: limit });
  });

  test("leaves a model the catalog does not list to the provider's output default", () => {
    // SAFETY: the helpers read only provider/modelOptions/modelId.
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "a-deployment-override-no-catalog-lists",
      modelOptions: {},
      provider: "openai",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    } as ResolvedTanStackTextModel;

    const options = mergeGenerationOptions({
      caching: noCaching,
      maxOutputTokens: chatTurnOutputTokens(model),
      model,
      serviceTier: "standard",
      temperature: undefined,
    });

    expect(chatTurnOutputTokens(model)).toBeUndefined();
    expect(options).not.toHaveProperty("max_output_tokens");
    expect(logs.at("WARN")).toEqual([]);
  });

  test("clamps and reports a thinking budget that leaves no room for the reply", () => {
    // SAFETY: the helpers read only provider/modelOptions/modelId.
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "claude-haiku-4-5-20251001",
      modelOptions: {
        thinking: { type: "enabled", budget_tokens: 1_000_000 },
      },
      provider: "anthropic",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    } as ResolvedTanStackTextModel;
    const limit = getOutputTokenLimit(model.modelId);
    // The fixture must reach the fault: the budget exceeds the model's limit.
    expect(limit).toBeLessThan(1_000_000);

    const allowance = chatTurnOutputTokens(model);
    expect(allowance).toBe(1);
    // No request of this budget fits the limit: Anthropic needs `max_tokens`
    // above the budget, so the smallest it accepts is sent, and reported.
    expect(
      mergeGenerationOptions({
        caching: noCaching,
        maxOutputTokens: allowance,
        model,
        serviceTier: "standard",
        temperature: undefined,
      }),
    ).toMatchObject({ max_tokens: 1_000_001 });
    expect(
      logs.at("WARN").map((record) => ({
        message: record.message,
        limit: record.attributes?.["ai.output_limit"],
        reservation: record.attributes?.["ai.thinking_reservation"],
      })),
    ).toEqual([
      {
        message: "tanstack_ai.output_allowance_clamped",
        limit,
        reservation: 1_000_000,
      },
    ]);
  });

  test("enables OpenAI prompt caching without sending a model-specific retention value", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge regression test.
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "gpt-5.5",
      modelOptions: {},
      provider: "openai",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "google/gemini-3.5-flash",
      modelOptions: { temperature: 0 },
      provider: "openrouter",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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
      // The model reasons by default, so its reasoning is reserved on top of
      // the reply's allowance.
      maxCompletionTokens: 1000 + 8192,
      serviceTier: "flex",
      temperature: 0,
    });
    expect(options).not.toHaveProperty("maxOutputTokens");
    expect(options).not.toHaveProperty("promptCacheKey");
    expect(options).not.toHaveProperty("sessionId");
  });

  describe("a short reply's allowance on a reasoning model", () => {
    // Gemini, OpenAI and OpenRouter count reasoning inside the one output
    // ceiling. A fast-role Gemini runs at its lowest level, `LOW`, which by
    // itself outspends a 200-token reply: without the reservation the run
    // stops at the ceiling before the answer starts.
    const SHORT_REPLY = 200;
    const ceilingFor = (
      provider: "google" | "openai" | "openrouter",
      modelId: string,
    ) => {
      const common = {
        adapter: providerAdapter,
        keySource: "byok",
        modelId,
      } as const;
      const model = (() => {
        switch (provider) {
          case "google":
            return {
              ...common,
              modelOptions: tanStackModelOptionsForTask({
                modelId,
                organizationId: null,
                provider,
                task: "short-text",
              }),
              provider,
            } satisfies ResolvedTanStackTextModel;
          case "openai":
            return {
              ...common,
              modelOptions: tanStackModelOptionsForTask({
                modelId,
                organizationId: null,
                provider,
                task: "short-text",
              }),
              provider,
            } satisfies ResolvedTanStackTextModel;
          case "openrouter":
            return {
              ...common,
              modelOptions: tanStackModelOptionsForTask({
                modelId,
                organizationId: null,
                provider,
                task: "short-text",
              }),
              provider,
            } satisfies ResolvedTanStackTextModel;
          default:
            provider satisfies never;
            throw new Panic({ message: "Unsupported TanStack AI provider" });
        }
      })();
      const options: object = mergeGenerationOptions({
        caching: noCaching,
        maxOutputTokens: SHORT_REPLY,
        model,
        serviceTier: "standard",
        temperature: undefined,
      });
      if ("maxOutputTokens" in options) {
        return options.maxOutputTokens;
      }
      if ("maxCompletionTokens" in options) {
        return options.maxCompletionTokens;
      }
      return "max_output_tokens" in options
        ? options.max_output_tokens
        : undefined;
    };

    test("Gemini reserves its thinking level on top of the reply", () => {
      expect(ceilingFor("google", "gemini-3.8-flash")).toBe(SHORT_REPLY + 4096);
    });

    test("OpenRouter reserves the reasoning effort it sends", () => {
      expect(ceilingFor("openrouter", "google/gemini-3.8-flash")).toBe(
        SHORT_REPLY + 4096,
      );
    });

    test("a model the catalog does not list keeps the reply's allowance", () => {
      expect(ceilingFor("google", "stella-no-such-model")).toBe(SHORT_REPLY);
    });

    test("the reservation never lifts a request past the model's limit", () => {
      const limit = getOutputTokenLimit("gemini-3.8-flash") ?? 0;
      expect(limit).toBeGreaterThan(0);
      const model = {
        adapter: providerAdapter,
        keySource: "byok",
        modelId: "gemini-3.8-flash",
        modelOptions: tanStackModelOptionsForTask({
          modelId: "gemini-3.8-flash",
          organizationId: null,
          provider: "google",
          task: "short-text",
        }),
        provider: "google",
      } satisfies ResolvedTanStackTextModel;
      expect(
        mergeGenerationOptions({
          caching: noCaching,
          maxOutputTokens: limit,
          model,
          serviceTier: "standard",
          temperature: undefined,
        }),
      ).toMatchObject({ maxOutputTokens: limit });
    });
  });

  test("forwards deferred service tiers to Gemini requests", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    const model = {
      adapter: {},
      keySource: "instance",
      // A catalogued id: caller temperature only survives the
      // capability gate for models with declared support.
      modelId: "gemini-3.1-pro-preview",
      modelOptions: { temperature: 0 },
      provider: "google",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "chat",
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

  test("rejects a cancelled object run as a cancelled generation", async () => {
    const controller = new AbortController();
    queueRun(cancelledObjectRun({ answer: "yes" }, controller));

    const caught = await generateObjectForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(isAnticipatedAIFailure(caught, classifyAIError(caught))).toBe(true);
    expect(
      gradeFailure(
        readEvidence(caught),
        failureSink({ event: "generation.test", expected: [] }),
      ),
    ).toMatchObject({
      reason: "generation_cancelled",
      grade: "anticipated",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "chat",
      serviceTier: "flex",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({
      message: PROVIDER_CALL_ERROR_MESSAGE,
      providerStatus: 400,
    });
    expect(providerRequests).toHaveLength(1);
  });

  // An adapter whose SDK exception reports the status as a plain field and
  // stringifies the response body into the message keeps neither once the
  // engine rebuilds the run error: the body in the message is the only
  // evidence left of what the provider answered. The streaming seam recovers
  // it, so this one has to as well; otherwise quota, billing, retired model
  // and outage all reach the classifier as one unnamed failure.
  test("classifies a generated object's failure whose only detail is the provider body", async () => {
    queueRun(
      throwingRun(
        new Error(
          JSON.stringify({
            error: {
              code: 429,
              message: "Resource has been exhausted.",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
        ),
      ),
    );

    const caught = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(classifyAIError(caught)).toBe("quota_exhausted");
    expect(isAnticipatedAIFailure(caught, classifyAIError(caught))).toBe(true);
  });

  test("leaves a generated object's plain-text failure unclassified", async () => {
    const providerError = new Error("The model is currently overloaded.");
    queueRun(throwingRun(providerError));

    const caught = await generateObjectForTestModel({
      caching: noCaching,
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ModelRunError);
    expect(caught).toMatchObject({ message: MODEL_RUN_ERROR_MESSAGE });
    expect(classifyAIError(caught)).toBe("unknown");
  });

  // A body-only failure reaches the service-tier retry predicate wrapped in
  // the 502 `HandlerError` the recovery above built for it. That 502 is this
  // service's own wrapper, not the provider's answer, so a predicate reading
  // it grades every permanent failure as a server error and spends a second
  // provider call on the standard tier to be told the same thing. The
  // provider's status is one `cause` down; the retry is decided on that, which
  // makes the decision agree with the name the same failure is given.
  for (const {
    kind,
    retriesOnStandardTier,
    status,
  } of PROVIDER_BODY_SERVICE_TIER_FALLBACK_MATRIX) {
    test(`${retriesOnStandardTier ? "retries" : "does not retry"} a deferred OpenAI object generation whose provider body is ${status}`, async () => {
      // Queued twice so the retried and non-retried rows differ only in how
      // many provider calls happened, never in whether the run failed.
      queueRun(throwingRun(providerBodyError(status)));
      queueRun(throwingRun(providerBodyError(status)));

      const caught = await generateObjectForTestModel({
        caching: noCaching,
        organizationId: null,
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer",
        managedAIResidency: "eu",
        orgAIConfig: null,
        outputSchema: v.strictObject({ answer: v.string() }),
        prompt: "Extract the answer.",
        task: "chat",
        serviceTier: "flex",
        tenantWorkspaceIds: [],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(classifyAIError(caught)).toBe(kind);
      expect(providerRequests).toHaveLength(retriesOnStandardTier ? 2 : 1);
      expect(providerRequests).toMatchObject(
        retriesOnStandardTier
          ? [
              { modelOptions: { service_tier: "flex" } },
              { modelOptions: { service_tier: "default" } },
            ]
          : [{ modelOptions: { service_tier: "flex" } }],
      );
    });
  }

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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      task: "pdf",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: `Summarize https://my.stll.app/workspaces/${tenantWorkspaceId}/matters and decision ${publicDecisionId}`,
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: `Summarize decision ${publicDecisionId}`,
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Draft it.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Draft it.",
      task: "chat",
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

describe("model dispatch within its admitted action", () => {
  const organizationId = toSafeId<"organization">("org_dispatch_lifetime");
  const dispatchOptions = {
    caching: noCaching,
    finishPolicy: "allow-incomplete",
    organizationId,
    userId: null,
    dataClass: "customer",
    managedAIResidency: "eu",
    orgAIConfig: null,
    prompt: "Rewrite it.",
    task: "chat",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  } as const;

  test("cancels a dispatch whose admission loses its lease, though the caller passed no signal", async () => {
    const lease = new AbortController();
    queueRun(cancelledTextRun(["half an ans"], lease));

    const caught = await admitModelDispatch({
      organizationId,
      userId: null,
      actionKind: "document-reviews.background",
      organizationStateDb: testOrganizationStateDb,
      signal: lease.signal,
      run: async (admission) =>
        await generateTextForTestModel({ ...dispatchOptions, admission }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(lease.signal.aborted).toBe(true);
    expect(caught).toMatchObject({ status: 502 });
    expect(
      gradeFailure(
        readEvidence(caught),
        failureSink({ event: "generation.test", expected: [] }),
      ),
    ).toMatchObject({ reason: "generation_cancelled" });
  });

  test("refuses a dispatch on a proof that outlived its admitted run", async () => {
    const escapedResult = await admitModelDispatch({
      organizationId,
      userId: null,
      actionKind: "templates.fill",
      organizationStateDb: testOrganizationStateDb,
      signal: new AbortController().signal,
      run: async (admission) => await Promise.resolve(admission),
    });
    const escaped = escapedResult.unwrap();
    expect(escaped.signal.aborted).toBe(true);
    queueRun(textRun(["never sent"]));

    const outlived = "Model dispatch outlived the action that admitted it";
    expect(
      await rejectionOf(
        generateTextForTestModel({ ...dispatchOptions, admission: escaped }),
      ),
    ).toHaveProperty("message", expect.stringContaining(outlived));
    const stream = streamTextForTestModel({
      ...dispatchOptions,
      admission: escaped,
    });
    expect(
      await rejectionOf(stream[Symbol.asyncIterator]().next()),
    ).toHaveProperty("message", expect.stringContaining(outlived));
    expect(providerRequests).toHaveLength(0);
  });
});

describe("TanStack AI text generation", () => {
  test("rejects incomplete output when complete generation is required", async () => {
    queueRun(textRun(["partial"], "length"));

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "require-complete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(caught).toBeInstanceOf(ModelOutputIncompleteError);
    expect(classifyAIError(caught)).toBe("output_incomplete");
  });

  // The output-ceiling stop reaches the engine as a `RUN_ERROR` on more than
  // one adapter, and `testModel` is not the provider that shape was first seen
  // on: normalizing only the adapters named for it leaves the same truncated
  // answer returned on one provider and raised as a failure on the next.
  test("returns the text a ceiling stop produced whichever adapter reports it", async () => {
    queueRun(
      runErrorRun({
        code: "max_tokens",
        deltas: ["as far as it got"],
        message: "The response hit the output ceiling.",
      }),
    );

    expect(
      await generateTextForTestModel({
        caching: noCaching,
        finishPolicy: "allow-incomplete",
        organizationId: null,
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer",
        managedAIResidency: "eu",
        orgAIConfig: null,
        prompt: "Recap it.",
        task: "chat",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      }),
    ).toBe("as far as it got");
  });

  test("accepts a ceiling stop as the length finish an output-ceiling caller allows", async () => {
    queueRun(
      runErrorRun({
        code: "max_tokens",
        deltas: ["as far as it got"],
        message: "The response hit the output ceiling.",
      }),
    );

    expect(
      await generateTextForTestModel({
        caching: noCaching,
        finishPolicy: "allow-output-ceiling",
        organizationId: null,
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer",
        managedAIResidency: "eu",
        orgAIConfig: null,
        prompt: "Recap it.",
        task: "chat",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      }),
    ).toBe("as far as it got");
  });

  // Reading the stop as a finish must not promote a truncated answer into a
  // whole one: the run is graded, not excused.
  test("still rejects a ceiling stop when a whole answer is required", async () => {
    queueRun(
      runErrorRun({
        code: "max_tokens",
        deltas: ["as far as it got"],
        message: "The response hit the output ceiling.",
      }),
    );

    const caught = await generateTextForTestModel({
      caching: noCaching,
      finishPolicy: "require-complete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Recap it.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Named as the incomplete answer it is, never left unclassified.
    expect(caught).toBeInstanceOf(ModelOutputIncompleteError);
    expect(caught).toMatchObject({
      message: MODEL_OUTPUT_INCOMPLETE_MESSAGE,
      status: 502,
    });
    expect(classifyAIError(caught)).toBe("output_incomplete");
    expect(gradeFailure(readEvidence(caught), anySink).reason).toBe(
      "model_output_incomplete",
    );
  });

  test("rejects a cancelled run instead of returning its truncated text", async () => {
    const controller = new AbortController();
    queueRun(cancelledTextRun(["half an ans"], controller));

    const caught = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
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
    // The failure owner reads the helper's own classification of the 502.
    expect(
      gradeFailure(
        readEvidence(caught),
        failureSink({ event: "generation.test", expected: [] }),
      ),
    ).toMatchObject({
      reason: "generation_cancelled",
      grade: "anticipated",
      rule: "brand",
    });
  });

  test("classifies an abort rejection from a cancelled run as anticipated", async () => {
    const controller = new AbortController();
    queueRun(abortRejectedRun(controller));

    const caught = await generateTextForTestModel({
      abortSignal: controller.signal,
      caching: noCaching,
      finishPolicy: "allow-incomplete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Say hello.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Say hello.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({
      code: PROVIDER_ERROR_CODE,
      message: PROVIDER_CALL_ERROR_MESSAGE,
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Say hello.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ code: PROVIDER_ERROR_CODE, status: 502 });
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Say hello.",
      task: "chat",
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
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Say hello.",
      task: "chat",
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
        userId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        dataClass: "customer",
        managedAIResidency: "eu",
        orgAIConfig: null,
        prompt: "Say hello.",
        task: "chat",
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
      code: PROVIDER_ERROR_CODE,
      message: PROVIDER_CALL_ERROR_MESSAGE,
      status: 502,
    });
  });
});

describe("prompt caching at the layer boundaries", () => {
  const caching = {
    enabled: true,
    scopeKey: "organization:contract-probe",
    ttl: "5m",
  } satisfies CachingDecision;
  const marker = { cache_control: { ttl: "5m", type: "ephemeral" } };
  const layered = {
    organization: "\n\nUser generally practices law in: Czechia.",
    static: "You are an AI inside stella.",
    turn: "\n\nUser registered as: First Member",
  } as const;
  const joined = `${layered.static}${layered.organization}${layered.turn}`;
  const modelOf = (
    provider: ResolvedTanStackTextModel["provider"],
    modelId: string,
  ) =>
    // The patch and the option merge read provider, modelId and modelOptions
    // only; the adapter is irrelevant here.
    asTestRaw<ResolvedTanStackTextModel>({
      adapter: {},
      keySource: "instance",
      modelId,
      modelOptions: {},
      provider,
    });
  const markerModels = [
    modelOf("anthropic", "claude-sonnet-4-6"),
    modelOf("openrouter", "anthropic/claude-sonnet-5.5"),
  ];
  const stringModels = [
    modelOf("openai", "gpt-5.5"),
    modelOf("openrouter", "openai/gpt-5.5"),
    modelOf("google", "gemini-3.5-flash"),
    modelOf("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    modelOf("mistral", "mistral-medium-latest"),
  ];

  test("marks the static and organization layers where the provider caches at markers", () => {
    for (const model of markerModels) {
      expect(systemPromptsPatch({ caching, model, system: layered })).toEqual({
        systemPrompts: [
          { content: layered.static, metadata: marker },
          { content: layered.organization, metadata: marker },
          layered.turn,
        ],
      });
      expect(
        systemPromptsPatch({
          caching,
          model,
          system: { ...layered, organization: "" },
        }),
      ).toEqual({
        systemPrompts: [
          { content: layered.static, metadata: marker },
          layered.turn,
        ],
      });
    }
  });

  test("sends every other provider, and any request without caching, the layers as one string", () => {
    for (const model of [...stringModels, ...markerModels]) {
      expect(
        systemPromptsPatch({
          caching: noCaching,
          model,
          system: layered,
        }),
      ).toEqual({ systemPrompts: [joined] });
    }
    for (const model of stringModels) {
      expect(systemPromptsPatch({ caching, model, system: layered })).toEqual({
        systemPrompts: [joined],
      });
    }
  });

  test("keeps a plain prompt's single end-of-prompt marker on Anthropic only", () => {
    const [anthropic, openRouterAnthropic] = markerModels;
    if (anthropic === undefined || openRouterAnthropic === undefined) {
      throw new TypeError("Both marker models are listed.");
    }
    expect(
      systemPromptsPatch({ caching, model: anthropic, system: joined }),
    ).toEqual({ systemPrompts: [{ content: joined, metadata: marker }] });
    expect(
      systemPromptsPatch({
        caching,
        model: openRouterAnthropic,
        system: joined,
      }),
    ).toEqual({ systemPrompts: [joined] });
  });

  test("adds the request-level marker only to a layered request on a marker-caching provider", () => {
    const optionsOf = (
      model: ResolvedTanStackTextModel,
      cacheConversation: boolean,
      decision: CachingDecision = caching,
    ) =>
      mergeGenerationOptions({
        cacheConversation,
        caching: decision,
        maxOutputTokens: 1000,
        model,
        serviceTier: "standard",
        temperature: undefined,
      });
    const [anthropic, openRouterAnthropic] = markerModels;
    if (anthropic === undefined || openRouterAnthropic === undefined) {
      throw new TypeError("Both marker models are listed.");
    }
    expect(optionsOf(anthropic, true)).toHaveProperty(
      "cache_control",
      marker.cache_control,
    );
    expect(optionsOf(openRouterAnthropic, true)).toHaveProperty(
      "cacheControl",
      marker.cache_control,
    );
    for (const model of markerModels) {
      expect(optionsOf(model, false)).toEqual(
        mergeGenerationOptions({
          caching,
          maxOutputTokens: 1000,
          model,
          serviceTier: "standard",
          temperature: undefined,
        }),
      );
      expect(optionsOf(model, true, noCaching)).not.toHaveProperty(
        "cache_control",
      );
      expect(optionsOf(model, true, noCaching)).not.toHaveProperty(
        "cacheControl",
      );
    }
    for (const model of stringModels) {
      expect(optionsOf(model, true)).toEqual(optionsOf(model, false));
    }
  });
});

describe("Anthropic extended-thinking budgets", () => {
  // Two modules decide the halves of one constraint: the task builder picks
  // `thinking.budget_tokens`, the merge picks `max_tokens`, and a budget that
  // reaches `max_tokens` describes a request Anthropic cannot serve. Walking
  // every offered model, task, and effort binds them, so a model added to the
  // budget form cannot drift back past the smallest allowance a caller asks
  // for.
  const SMALLEST_CALLER_ALLOWANCE = 1;

  test("keeps every emitted budget under the merged max_tokens", () => {
    for (const modelId of BYOK_MODEL_OPTIONS.anthropic) {
      for (const task of MODEL_TASKS) {
        for (const reasoningEffort of [undefined, ...REASONING_EFFORTS]) {
          const modelOptions = tanStackModelOptionsForTask({
            modelId,
            organizationId: null,
            provider: "anthropic",
            reasoningEffort,
            task,
          });
          const model = {
            adapter: providerAdapter,
            keySource: "byok",
            modelId,
            modelOptions,
            provider: "anthropic",
          } satisfies ResolvedTanStackTextModel;

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

  test("keeps every offered model's whole chat request within its output limit", () => {
    for (const modelId of BYOK_MODEL_OPTIONS.anthropic) {
      for (const task of MODEL_TASKS) {
        for (const reasoningEffort of [undefined, ...REASONING_EFFORTS]) {
          const model = {
            adapter: providerAdapter,
            keySource: "byok",
            modelId,
            modelOptions: tanStackModelOptionsForTask({
              modelId,
              organizationId: null,
              provider: "anthropic",
              reasoningEffort,
              task,
            }),
            provider: "anthropic",
          } satisfies ResolvedTanStackTextModel;

          const merged: Record<string, unknown> = {
            ...mergeGenerationOptions({
              caching: noCaching,
              maxOutputTokens: chatTurnOutputTokens(model),
              model,
              serviceTier: "standard",
              temperature: undefined,
            }),
          };

          expect(merged["max_tokens"]).toBe(getOutputTokenLimit(modelId));
        }
      }
    }
    // No offered model reaches the clamp: every budget leaves room.
    expect(logs.at("WARN")).toEqual([]);
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

class ForeignTaggedError extends TaggedError("ForeignTaggedError")<{
  message: string;
}> {}

describe("provider status recovery preserves failure ownership", () => {
  for (const error of [
    new HandlerError({
      status: 422,
      code: "validation_failed",
      message: "Invalid input",
    }),
    new ChatLoopDetectedError({ message: "Loop detected" }),
    new ChatEmptyCompletionError({ message: "Empty completion" }),
  ]) {
    test(`passes through ${error._tag} unchanged`, () => {
      expect(withRecoveredProviderStatus({ error, model: testModel })).toBe(
        error,
      );
    });
  }

  for (const { name, error } of [
    { name: "an Error", error: new Error("SENTINEL_LIBRARY_TEXT") },
    { name: "a TypeError", error: new TypeError("SENTINEL_LIBRARY_TEXT") },
    { name: "a thrown string", error: "SENTINEL_LIBRARY_TEXT" },
    { name: "a message object", error: { message: "SENTINEL_LIBRARY_TEXT" } },
    { name: "undefined", error: undefined },
    {
      name: "a foreign tagged error",
      error: new ForeignTaggedError({ message: "SENTINEL_LIBRARY_TEXT" }),
    },
    { name: "a panic", error: new Panic({ message: "SENTINEL_LIBRARY_TEXT" }) },
    {
      name: "an unhandled exception",
      error: new UnhandledException({
        cause: new Error("SENTINEL_LIBRARY_TEXT"),
      }),
    },
  ]) {
    test(`replaces ${name} with a fixed-message model run error`, () => {
      const recovered = withRecoveredProviderStatus({
        error,
        model: testModel,
      });
      expect(recovered).toBeInstanceOf(ModelRunError);
      expect(recovered).toMatchObject({
        message: MODEL_RUN_ERROR_MESSAGE,
        provider: testModel.provider,
        keySource: testModel.keySource,
      });
      expect(JSON.stringify(recovered)).not.toContain("SENTINEL");
      expect(String(asTestRaw<Error>(recovered).stack)).not.toContain(
        "SENTINEL",
      );
    });
  }

  test("keeps the caller's own abort", () => {
    const controller = new AbortController();
    controller.abort(new Error("caller abort"));
    const error: unknown = controller.signal.reason;
    expect(
      withRecoveredProviderStatus({
        error,
        model: testModel,
        abortSignal: controller.signal,
      }),
    ).toBe(error);
  });

  test("every foreign model-run failure leaves with an application-owned message and code", () => {
    const SENTINEL = "SENTINEL_ARBITRARY_PROVIDER_TEXT";
    const sentinelText = fc.string().map((text) => `${SENTINEL}${text}`);
    const foreignFailure = fc.oneof(
      sentinelText.map((message) => new Error(message)),
      sentinelText,
      fc
        .record({
          message: sentinelText,
          code: sentinelText,
          status: fc.integer({ min: 100, max: 599 }),
        })
        .map(({ message, code, status }) =>
          Object.assign(new Error(message), { code, status }),
        ),
      fc
        .record({ message: sentinelText, code: sentinelText })
        .map(
          ({ message, code }) =>
            new Error(JSON.stringify({ error: { message, code } })),
        ),
      fc
        .record({
          message: sentinelText,
          status: fc.integer({ min: 100, max: 599 }),
        })
        .map(
          ({ message, status }) =>
            new Error(message, {
              cause: Object.assign(new Error(message), { status }),
            }),
        ),
    );
    assertProperty(
      "every foreign model-run failure leaves with an application-owned message and code",
      fc.property(foreignFailure, (error) => {
        const recovered = withRecoveredProviderStatus({
          error,
          model: testModel,
        });
        expect(
          recovered instanceof ProviderCallError ||
            recovered instanceof ModelRunError,
        ).toBe(true);
        expect([
          PROVIDER_CALL_ERROR_MESSAGE,
          MODEL_RUN_ERROR_MESSAGE,
        ]).toContain(asTestRaw<Error>(recovered).message);
        expect([undefined, PROVIDER_ERROR_CODE]).toContain(
          asTestRaw<{ code?: string }>(recovered).code,
        );
        expect(JSON.stringify(recovered)).not.toContain(SENTINEL);
        expect(String(asTestRaw<Error>(recovered).stack)).not.toContain(
          SENTINEL,
        );
      }),
    );
  });

  test("projects a provider outage through wrapped causes without retaining its body", () => {
    const sentinel = "SENTINEL_PROVIDER_BODY";
    const error = new Error("Generation failed", {
      cause: Object.assign(new Error(sentinel), {
        status: 503,
        isRetryable: true,
      }),
    });
    const recovered = withRecoveredProviderStatus({ error, model: testModel });
    expect(recovered).toBeInstanceOf(ProviderCallError);
    expect(recovered).toMatchObject({
      providerStatus: 503,
      kind: "provider_unavailable",
      cause: { status: 503, isRetryable: true },
    });
    expect(JSON.stringify(recovered)).not.toContain(sentinel);
  });
});

test("recovers an unclassified provider failure wrapped without a status", () => {
  const provider = new ProviderCallError({
    model: testModel,
    status: 502,
    kind: "unknown",
  });
  const error = new Error("SENTINEL_WRAPPER", { cause: provider });
  const recovered = withRecoveredProviderStatus({ error, model: testModel });
  expect(recovered).toBeInstanceOf(ProviderCallError);
  expect(JSON.stringify(recovered)).not.toContain("SENTINEL_WRAPPER");
});

describe("model output that fails its schema", () => {
  const SENTINEL = "SENTINEL_MODEL_OUTPUT";
  const objectOptions = {
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    caching: noCaching,
    organizationId: null,
    userId: null,
    dataClass: "customer" as const,
    managedAIResidency: "eu" as const,
    orgAIConfig: null,
    outputSchema: v.strictObject({ answer: v.string() }),
    prompt: "Extract the answer.",
    task: "chat" as const,
    serviceTier: "standard" as const,
    tenantWorkspaceIds: [],
  };

  // A schema mismatch gets one repair turn, so it is queued twice; text that
  // is not JSON fails in the engine before any repair.
  for (const { name, runs } of [
    {
      name: "an object with an unexpected key",
      runs: [
        objectRun({ answer: "ok", [SENTINEL]: SENTINEL }),
        objectRun({ answer: "ok", [SENTINEL]: SENTINEL }),
      ],
    },
    {
      name: "a value of the wrong type",
      runs: [
        objectRun({ answer: [SENTINEL] }),
        objectRun({ answer: [SENTINEL] }),
      ],
    },
    {
      name: "text that is not JSON",
      runs: [objectRun(undefined, `${SENTINEL} is not JSON`)],
    },
  ]) {
    test(`reports ${name} without quoting it`, async () => {
      queuedRuns.push(...runs);

      const caught = await generateObjectForTestModel(objectOptions).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(ModelRunError);
      expect(JSON.stringify(caught)).not.toContain(SENTINEL);
      expect(String(asTestRaw<Error>(caught).stack)).not.toContain(SENTINEL);
    });
  }
});

describe("a structured answer its schema rejects gets one repair turn", () => {
  const objectOptions = {
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    caching: noCaching,
    organizationId: null,
    userId: null,
    dataClass: "customer" as const,
    managedAIResidency: "eu" as const,
    orgAIConfig: null,
    outputSchema: v.strictObject({ answer: v.string(), page: v.number() }),
    prompt: "Extract the answer.",
    task: "chat" as const,
    serviceTier: "standard" as const,
    tenantWorkspaceIds: [],
  };

  const outcomeLogs = () =>
    logs.records
      .filter(({ message }) => message === "ai.structured_output.outcome")
      .map(({ attributes }) => ({
        result: attributes?.["ai.structured_output.result"],
        rung: attributes?.["ai.structured_output.rung"],
        issueTypes: attributes?.["ai.structured_output.issue_types"],
      }));

  const lastUserContent = (request: CapturedProviderRequest | undefined) => {
    const messages = request?.messages;
    const last: unknown = Array.isArray(messages) ? messages.at(-1) : undefined;
    return JSON.stringify(last);
  };

  test("a first answer that matches is returned without a repair turn", async () => {
    queueRun(objectRun({ answer: "ok", page: 3 }));

    const object = await generateObjectForTestModel(objectOptions);

    expect(object).toEqual({ answer: "ok", page: 3 });
    expect(providerRequests).toHaveLength(1);
    expect(outcomeLogs()).toEqual([]);
  });

  test("the same model is shown where its answer breaks the schema and its fix is returned", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: 3 }));

    const object = await generateObjectForTestModel(objectOptions);

    expect(object).toEqual({ answer: "ok", page: 3 });
    expect(providerRequests).toHaveLength(2);
    const repairRequest = providerRequests[1];
    expect(lastUserContent(repairRequest)).toContain("page: expected number");
    // The repair turn names the path and the expectation, never the value.
    expect(lastUserContent(repairRequest)).not.toContain("three");
    expect(outcomeLogs()).toEqual([
      { result: "ok", rung: "model_repair", issueTypes: "number" },
    ]);
  });

  test("a repair that still breaks the schema fails as invalid output after one turn", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: "3" }));

    const caught = await generateObjectForTestModel(objectOptions).then(
      () => undefined,
      (error: unknown) => error,
    );

    // "3" is not converted to 3: the answer passes the schema or fails.
    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(classifyAIError(caught)).toBe("output_invalid");
    expect(providerRequests).toHaveLength(2);
    expect(outcomeLogs()).toEqual([
      { result: "failed", rung: "fallback_model", issueTypes: "number" },
    ]);
    // The outcome line carries paths and types, never the model's values.
    expect(JSON.stringify(logs.records)).not.toContain("three");
  });

  test("a missing field is not filled in on the model's behalf", async () => {
    queueRun(objectRun({ answer: "ok" }));
    queueRun(objectRun({ answer: "ok" }));

    const caught = await generateObjectForTestModel(objectOptions).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(lastUserContent(providerRequests[1])).toContain("page: expected");
  });

  test("a cancelled repair turn is a cancellation, not invalid output", async () => {
    const controller = new AbortController();
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(cancelledObjectRun({ answer: "ok", page: 3 }, controller));

    const caught = await generateObjectForTestModel({
      ...objectOptions,
      abortSignal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
    expect(
      gradeFailure(
        readEvidence(caught),
        failureSink({ event: "generation.test", expected: [] }),
      ),
    ).toMatchObject({ reason: "generation_cancelled" });
    // The tried repair is still counted.
    expect(outcomeLogs()).toEqual([
      { result: "failed", rung: "repair_failed", issueTypes: "number" },
    ]);
  });
});

describe("a chat run a caller consumes itself", () => {
  const SENTINEL = "SENTINEL_RUN_ERROR_TEXT";

  const consume = async () => {
    const chunks: unknown[] = [];
    const caught = await (async () => {
      for await (const chunk of streamTanStackChatRun({
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        userId: null,
        model: testModel,
        adapter: testModel.adapter,
        messages: [{ role: "user", content: "Hello" }],
      })) {
        chunks.push(chunk);
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    return { chunks, caught };
  };

  test("hands out a run error with the fixed message and the classified kind", async () => {
    queueRun(
      runErrorRun({
        code: `${SENTINEL}_code`,
        message: JSON.stringify({
          error: { code: 429, message: SENTINEL },
        }),
      }),
    );

    const { chunks, caught } = await consume();

    expect(caught).toBeUndefined();
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: PROVIDER_CALL_ERROR_MESSAGE,
        code: "quota_exhausted",
      }),
    );
    expect(JSON.stringify(chunks)).not.toContain(SENTINEL);
  });

  test("hands out a thrown provider failure without its text", async () => {
    queueRun(throwingRun(new Error(SENTINEL)));

    const { chunks, caught } = await consume();

    // The engine reports an adapter exception as a run error chunk or
    // rethrows it; either way no provider text leaves the wrapper.
    expect([undefined, "ProviderCallError", "ModelRunError"]).toContain(
      asTestRaw<Error | undefined>(caught)?.name,
    );
    expect(JSON.stringify({ chunks, caught })).not.toContain(SENTINEL);
  });
});

describe("an unrepaired structured answer falls back once within the approved set", () => {
  const primaryModelId = BYOK_MODEL_OPTIONS.openai[0];
  const orgAIConfig = {
    providers: [{ provider: "openai", apiKey: "fixture-key" }],
    overrideModels: null,
    decision: null,
  } satisfies OrgAIConfig;
  const options = {
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    organizationId: null,
    userId: null,
    orgAIConfig,
    caching: noCaching,
    dataClass: "customer",
    managedAIResidency: "us",
    outputSchema: v.strictObject({ answer: v.string(), page: v.number() }),
    prompt: "Extract the answer.",
    task: "chat",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  } as const;

  type ResolveOptions = Parameters<
    NonNullable<
      Parameters<typeof generateTanStackObjectForTask>[0]["resolveTextModel"]
    >
  >[0];
  const resolver = (request: ResolveOptions) => ({
    ...testModel,
    modelId: request.modelId?.split("::").slice(1).join("::") ?? primaryModelId,
  });
  const fallbackOutcome = () =>
    logs.records.findLast(
      ({ message }) => message === "ai.structured_output.outcome",
    )?.attributes;

  test("a second approved model gets only the original request and must match the full schema", async () => {
    queueRun(objectRun({ answer: "SENTINEL_PRIMARY", page: "three" }));
    queueRun(objectRun({ answer: "SENTINEL_REPAIR", page: "3" }));
    queueRun(objectRun({ answer: "ok", page: 3 }));
    const resolutions: ResolveOptions[] = [];
    const result = await generateTanStackObjectForTask({
      ...options,
      resolveTextModel: (request) => {
        resolutions.push(request);
        return resolver(request);
      },
    });
    expect(result).toEqual({ answer: "ok", page: 3 });
    expect(resolutions).toHaveLength(2);
    const fallback = resolutions[1];
    expect(fallback?.modelId).toStartWith("openai::");
    expect(fallback?.modelId).not.toBe(`openai::${primaryModelId}`);
    expect(fallback?.admission).toBe(options.admission);
    expect(fallback).toMatchObject({
      dataClass: "customer",
      managedAIResidency: "us",
    });
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests[2]?.messages).toEqual(
      providerRequests[0]?.messages,
    );
    expect(JSON.stringify(providerRequests[2])).not.toContain("SENTINEL_");
    expect(fallbackOutcome()).toMatchObject({
      "ai.structured_output.rung": "fallback_model",
      "ai.structured_output.result": "ok",
      "ai.structured_output.fallback_model_id": fallback?.modelId,
    });
    expect(JSON.stringify(logs.records)).not.toContain("SENTINEL_");
  });

  test("fallback stays on the assigned provider and reuses live organization admission", async () => {
    queueRun(objectRun({ answer: "SENTINEL_PRIMARY", page: "three" }));
    queueRun(objectRun({ answer: "SENTINEL_REPAIR", page: "3" }));
    queueRun(objectRun({ answer: "ok", page: 3 }));
    const organizationId = toSafeId<"organization">("org_structured_fallback");
    const resolutions: ResolveOptions[] = [];
    const result = await admitModelDispatch({
      organizationId,
      userId: null,
      actionKind: "templates.fill",
      organizationStateDb: testOrganizationStateDb,
      signal: new AbortController().signal,
      run: async (admission) =>
        await generateTanStackObjectForTask({
          ...options,
          organizationId,
          admission,
          orgAIConfig: {
            ...orgAIConfig,
            providers: [
              ...orgAIConfig.providers,
              { provider: "google", apiKey: "fixture-google-key" },
            ],
          },
          resolveTextModel: (request) => {
            resolutions.push(request);
            expect(request.admission).toBe(admission);
            expect(admission.signal.aborted).toBe(false);
            return resolver(request);
          },
        }),
    });
    expect(result.unwrap()).toEqual({ answer: "ok", page: 3 });
    expect(resolutions).toHaveLength(2);
    expect(resolutions[1]?.modelId).toStartWith("openai::");
    expect(providerRequests[2]?.messages).toEqual(
      providerRequests[0]?.messages,
    );
    expect(JSON.stringify(providerRequests[2])).not.toContain("SENTINEL_");
  });

  test("a pinned resolver cannot resend the request as a different model", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: "3" }));
    queueRun(objectRun({ answer: "ok", page: "4" }));
    const caught = await rejectionOf(
      generateTanStackObjectForTask({
        ...options,
        resolveTextModel: () => resolver(options),
      }),
    );
    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(providerRequests).toHaveLength(2);
  });

  test("a throttled fallback retries its own request without restarting the ladder", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: "3" }));
    queueRun({
      type: "throw",
      error: Object.assign(
        new Error("Rate limit exceeded. Please retry in 1ms."),
        {
          status: 429,
          headers: new Headers({ "retry-after-ms": "1" }),
        },
      ),
    });
    queueRun(objectRun({ answer: "ok", page: 3 }));
    const resolutions: ResolveOptions[] = [];
    expect(
      await generateTanStackObjectForTask({
        ...options,
        resolveTextModel: (request) => {
          resolutions.push(request);
          return resolver(request);
        },
      }),
    ).toEqual({ answer: "ok", page: 3 });
    expect(resolutions).toHaveLength(2);
    expect(providerRequests).toHaveLength(4);
    expect(providerRequests[3]?.messages).toEqual(
      providerRequests[2]?.messages,
    );
    expect(providerRequests[3]?.messages).toEqual(
      providerRequests[0]?.messages,
    );
  });

  test("a repair rejected as invalid structured output still reaches the approved fallback", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(
      throwingRun(
        Object.assign(new Error("SENTINEL_INVALID_REPAIR"), {
          code: "structured-output-validation-failed",
        }),
      ),
    );
    queueRun(objectRun({ answer: "ok", page: 3 }));
    expect(
      await generateTanStackObjectForTask({
        ...options,
        resolveTextModel: resolver,
      }),
    ).toEqual({ answer: "ok", page: 3 });
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests[2]?.messages).toEqual(
      providerRequests[0]?.messages,
    );
    expect(JSON.stringify(providerRequests[2])).not.toContain("SENTINEL_");
    expect(fallbackOutcome()).toMatchObject({
      "ai.structured_output.rung": "fallback_model",
    });
  });

  test("the fallback is never repaired or coerced", async () => {
    for (const page of ["three", "3", "4"]) {
      queueRun(objectRun({ answer: "ok", page }));
    }
    const caught = await rejectionOf(
      generateTanStackObjectForTask({
        ...options,
        resolveTextModel: resolver,
      }),
    );
    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(providerRequests).toHaveLength(3);
    expect(fallbackOutcome()).toMatchObject({
      "ai.structured_output.rung": "fallback_model",
      "ai.structured_output.result": "failed",
    });
  });

  test("an organization with no other role model records a skipped fallback", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: "3" }));
    const caught = await rejectionOf(
      generateTanStackObjectForTask({
        ...options,
        orgAIConfig: { providers: [], overrideModels: null, decision: null },
        resolveTextModel: () => resolver(options),
      }),
    );
    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(providerRequests).toHaveLength(2);
    expect(fallbackOutcome()).toMatchObject({
      "ai.structured_output.rung": "fallback_skipped",
      "ai.structured_output.result": "failed",
    });
  });

  test("fallback resolution shares the original deadline and abort signal", async () => {
    queueRun(objectRun({ answer: "ok", page: "three" }));
    queueRun(objectRun({ answer: "ok", page: "3" }));
    const pending = Promise.withResolvers<ResolvedTanStackTextModel>();
    const signals: (AbortSignal | undefined)[] = [];
    const caught = await rejectionOf(
      generateTanStackObjectForTask({
        ...options,
        deadlineMs: 40,
        resolveTextModel: async (request) => {
          signals.push(request.abortSignal);
          return request.modelId === undefined
            ? resolver(options)
            : await pending.promise;
        },
      }),
    );
    expect(caught).toBeInstanceOf(ModelDeadlineExceededError);
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(true);
    expect(providerRequests).toHaveLength(2);
  });
});

// A provider that streams its structured answer natively, as Gemini's adapter
// does: the engine reads the adapter's own run error codes from this path,
// which is where a cut-off answer is noticed in production.
type StructuredStream = (
  signal: AbortSignal | undefined,
) => AsyncIterable<StreamChunk>;

const structuredStreamModel = (
  stream: StructuredStream,
): ResolvedTanStackTextModel => {
  const adapter: AnyTextAdapter = {
    ...providerAdapter,
    structuredOutputStream: (options) =>
      stream(options.chatOptions.request?.signal ?? undefined),
  };
  return { ...testModel, adapter };
};

const runStarted = {
  type: EventType.RUN_STARTED,
  runId: PROVIDER_RUN_ID,
  threadId: PROVIDER_THREAD_ID,
} satisfies StreamChunk;

const partialAnswer = (delta: string): StreamChunk[] => [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: PROVIDER_MESSAGE_ID,
    role: "assistant",
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: PROVIDER_MESSAGE_ID,
    delta,
  },
];

const structuredRunError = (code: string, message: string): StreamChunk => ({
  type: EventType.RUN_ERROR,
  runId: PROVIDER_RUN_ID,
  threadId: PROVIDER_THREAD_ID,
  code,
  message,
});

const untilAborted = async (signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) {
    throw new Error("The engine must hand the adapter the run's signal");
  }
  if (signal.aborted) {
    return;
  }
  const aborted = Promise.withResolvers<undefined>();
  signal.addEventListener(
    "abort",
    () => {
      aborted.resolve(undefined);
    },
    { once: true },
  );
  await aborted.promise;
};

const OBJECT_OPTIONS = {
  admission: NO_ORGANIZATION_MODEL_DISPATCH,
  caching: noCaching,
  organizationId: null,
  userId: null,
  dataClass: "customer",
  managedAIResidency: "eu",
  orgAIConfig: null,
  outputSchema: v.strictObject({ answer: v.string() }),
  prompt: "Extract the answer.",
  task: "chat",
  serviceTier: "standard",
  tenantWorkspaceIds: [],
} as const;

const generateObjectWith = async (
  stream: StructuredStream,
  extra: { abortSignal?: AbortSignal; deadlineMs?: number } = {},
): Promise<unknown> =>
  await generateTanStackObjectForTask({
    ...OBJECT_OPTIONS,
    ...extra,
    resolveTextModel: () => structuredStreamModel(stream),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

describe("a structured answer that arrived but cannot be used is named", () => {
  const PARTIAL_ANSWER = "partial";

  test("an answer the provider stopped at its output ceiling is incomplete", async () => {
    const caught = await generateObjectWith(async function* () {
      yield runStarted;
      yield* partialAnswer(`{"answer": "${PARTIAL_ANSWER}`);
      yield structuredRunError(
        "max_tokens",
        "The response was cut off because the maximum token limit was reached.",
      );
    });

    expect(caught).toBeInstanceOf(ModelOutputIncompleteError);
    expect(classifyAIError(caught)).toBe("output_incomplete");
    expect(gradeFailure(readEvidence(caught), anySink)).toMatchObject({
      reason: "model_output_incomplete",
      grade: "transient",
    });
  });

  test("OpenAI's spelling of the output-ceiling stop is incomplete too", async () => {
    const caught = await generateObjectWith(async function* () {
      yield runStarted;
      yield* partialAnswer(`{"answer": "${PARTIAL_ANSWER}`);
      yield structuredRunError("incomplete", "max_output_tokens");
    });

    expect(caught).toBeInstanceOf(ModelOutputIncompleteError);
  });

  test("a cut-off answer that does not parse is incomplete, not unclassified", async () => {
    const caught = await generateObjectWith(async function* () {
      yield runStarted;
      yield* partialAnswer(`{"answer": "${PARTIAL_ANSWER}`);
      yield structuredRunError(
        "parse-error",
        `Failed to parse JSON content: {"answer": "${PARTIAL_ANSWER}`,
      );
    });

    expect(caught).toBeInstanceOf(ModelOutputIncompleteError);
    expect(gradeFailure(readEvidence(caught), anySink).reason).toBe(
      "model_output_incomplete",
    );
  });

  test("a complete answer its schema rejects is invalid", async () => {
    const caught = await generateObjectWith(async function* () {
      yield runStarted;
      const raw = JSON.stringify({ answer: [PARTIAL_ANSWER] });
      yield* partialAnswer(raw);
      yield {
        type: EventType.CUSTOM,
        name: "structured-output.complete",
        value: { object: { answer: [PARTIAL_ANSWER] }, raw },
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId: PROVIDER_RUN_ID,
        threadId: PROVIDER_THREAD_ID,
        finishReason: "stop",
      } satisfies StreamChunk;
    });

    expect(caught).toBeInstanceOf(ModelOutputInvalidError);
    expect(classifyAIError(caught)).toBe("output_invalid");
    expect(gradeFailure(readEvidence(caught), anySink).reason).toBe(
      "model_output_invalid",
    );
  });

  // The codes are a closed vocabulary: a code the engine or adapter does not
  // use for an unusable answer must not be read as one.
  test("an unrelated run error code stays the generic model run error", async () => {
    const caught = await generateObjectWith(async function* () {
      yield runStarted;
      yield structuredRunError("something-else", "Unrelated failure.");
    });

    expect(caught).toBeInstanceOf(ModelRunError);
    expect(caught).not.toBeInstanceOf(ModelOutputIncompleteError);
    expect(caught).not.toBeInstanceOf(ModelOutputInvalidError);
  });
});

describe("a generation bounded by its own deadline", () => {
  test("a structured run that outlives its deadline fails as timed out", async () => {
    const started = performance.now();
    const caught = await generateObjectWith(
      async function* (signal) {
        yield runStarted;
        await untilAborted(signal);
      },
      { deadlineMs: 40 },
    );

    expect(caught).toBeInstanceOf(ModelDeadlineExceededError);
    expect(caught).toMatchObject({ deadlineMs: 40, status: 502 });
    expect(classifyAIError(caught)).toBe("deadline_exceeded");
    expect(gradeFailure(readEvidence(caught), anySink)).toMatchObject({
      reason: "model_deadline_exceeded",
      grade: "transient",
    });
    // The run ended at the deadline, not whenever the provider gave up.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  // The deadline bounds model resolution as well as the provider call: a
  // resolver that never settles must not hold the run past it.
  test("a run whose model resolution never settles fails as timed out", async () => {
    const pending = Promise.withResolvers<ResolvedTanStackTextModel>();
    const resolveModel = async () => await pending.promise;
    const object = await generateTanStackObjectForTask({
      ...OBJECT_OPTIONS,
      deadlineMs: 40,
      resolveTextModel: resolveModel,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const text = await generateTanStackTextForTask({
      caching: noCaching,
      deadlineMs: 40,
      finishPolicy: "require-complete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
      resolveTextModel: resolveModel,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    for (const caught of [object, text]) {
      expect(caught).toBeInstanceOf(ModelDeadlineExceededError);
      expect(caught).toMatchObject({ deadlineMs: 40, status: 502 });
      expect(classifyAIError(caught)).toBe("deadline_exceeded");
      expect(gradeFailure(readEvidence(caught), anySink).reason).toBe(
        "model_deadline_exceeded",
      );
    }
    expect(providerRequests).toHaveLength(0);
  });

  test("a caller's own abort under a deadline that has not fired is a cancellation", async () => {
    const controller = new AbortController();
    const caught = await generateObjectWith(
      async function* (signal) {
        yield runStarted;
        controller.abort();
        await untilAborted(signal);
      },
      { abortSignal: controller.signal, deadlineMs: 60_000 },
    );

    expect(caught).not.toBeInstanceOf(ModelDeadlineExceededError);
    expect(gradeFailure(readEvidence(caught), anySink).reason).toBe(
      "generation_cancelled",
    );
  });

  test("a run that answers within its deadline returns the answer", async () => {
    const answer = { answer: "on time" };
    const raw = JSON.stringify(answer);
    expect(
      await generateTanStackObjectForTask({
        ...OBJECT_OPTIONS,
        deadlineMs: 60_000,
        resolveTextModel: () =>
          structuredStreamModel(async function* () {
            yield runStarted;
            yield* partialAnswer(raw);
            yield {
              type: EventType.CUSTOM,
              name: "structured-output.complete",
              value: { object: answer, raw },
            } satisfies StreamChunk;
            yield {
              type: EventType.RUN_FINISHED,
              runId: PROVIDER_RUN_ID,
              threadId: PROVIDER_THREAD_ID,
              finishReason: "stop",
            } satisfies StreamChunk;
          }),
      }),
    ).toEqual(answer);
  });

  test("a text run that outlives its deadline fails as timed out", async () => {
    const adapter: AnyTextAdapter = {
      ...providerAdapter,
      async *chatStream(options) {
        yield runStarted;
        await untilAborted(options.request?.signal ?? undefined);
      },
    };
    const caught = await generateTanStackTextForTask({
      caching: noCaching,
      deadlineMs: 40,
      finishPolicy: "require-complete",
      organizationId: null,
      userId: null,
      admission: NO_ORGANIZATION_MODEL_DISPATCH,
      dataClass: "customer",
      managedAIResidency: "eu",
      orgAIConfig: null,
      prompt: "Rewrite it.",
      task: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [],
      resolveTextModel: () => ({ ...testModel, adapter }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ModelDeadlineExceededError);
    expect(classifyAIError(caught)).toBe("deadline_exceeded");
  });
});

describe("an output token budget bounded by the model's catalog limit", () => {
  // SAFETY: the helpers read only provider/modelOptions/modelId.
  const modelFor = (
    provider: (typeof TANSTACK_AI_PROVIDERS)[number],
    modelId: string,
  ): ResolvedTanStackTextModel =>
    /* oxlint-disable typescript/no-unsafe-type-assertion -- focused pure helper test */
    ({
      adapter: {},
      keySource: "byok",
      modelId,
      modelOptions: {},
      provider,
    }) as ResolvedTanStackTextModel;
  /* oxlint-enable typescript/no-unsafe-type-assertion */

  test("every offered model answers a budget within its own limit", () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        const limit = getOutputTokenLimit(modelId);
        // The catalog guard: an offered model the catalog gives no limit
        // would leave the budget to the provider's own default.
        expect(limit).toBeGreaterThan(0);
        const model = modelFor(provider, modelId);
        for (const budget of [1, 16_384, 10_000_000]) {
          expect(outputTokensWithinModelLimit(model, budget)).toBe(
            Math.min(budget, limit ?? 0),
          );
        }
      }
    }
  });

  test("the budget reaches the request as the provider's output option", async () => {
    queueRun(objectRun({ answer: "ok" }));
    const model = modelFor("openai", "gpt-5.5");
    expect(getOutputTokenLimit("gpt-5.5")).toBeGreaterThan(16_384);

    await generateTanStackObjectForTask({
      ...OBJECT_OPTIONS,
      outputTokenBudget: 16_384,
      resolveTextModel: () => ({ ...model, adapter: providerAdapter }),
    });

    expect(providerRequests.at(-1)?.modelOptions).toMatchObject({
      max_output_tokens: 16_384,
    });
  });

  test("a model the catalog does not list keeps the provider's default", async () => {
    queueRun(objectRun({ answer: "ok" }));

    await generateObjectForTestModel({
      ...OBJECT_OPTIONS,
      outputTokenBudget: 16_384,
    });

    expect(providerRequests.at(-1)?.modelOptions).not.toHaveProperty(
      "max_output_tokens",
    );
  });

  test("a budget that is not a positive integer is refused", () => {
    const model = modelFor("openai", "gpt-5.5");
    for (const budget of [0, -1, 1.5, Number.NaN]) {
      expect(() => outputTokensWithinModelLimit(model, budget)).toThrow(
        "An output token budget must be a positive integer",
      );
    }
  });
});
