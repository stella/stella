import * as realTanStackAI from "@tanstack/ai";
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import type { CachingDecision } from "@/api/lib/ai-config";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";
import {
  projectSchemaInputJsonSchema,
  toTanStackValibotSchema,
} from "@/api/lib/tanstack-ai-schema";

type CapturedChatOptions = {
  modelOptions?: unknown;
  outputSchema?: unknown;
  stream?: unknown;
};

const capturedChatOptions: CapturedChatOptions[] = [];
let nextChatResult: unknown = { answer: "ok" };
const nextChatResults: unknown[] = [];
let nextChatError: Error | undefined;

const chat = (options: unknown): unknown => {
  capturedChatOptions.push(captureChatOptions(options));
  if (nextChatError !== undefined) {
    const error = nextChatError;
    nextChatError = undefined;
    return rejectChat(error);
  }
  const queuedResult = nextChatResults.shift();
  if (queuedResult !== undefined) {
    return queuedResult;
  }
  return nextChatResult;
};

const rejectChat = async (error: Error): Promise<never> => {
  throw error;
};

void mock.module("@tanstack/ai", () => ({
  ...realTanStackAI,
  chat,
}));

void mock.module("@/api/lib/tanstack-ai-models", () => ({
  ...realTanStackAIModels,
  getTanStackTextModelById: () => testModel,
  getTanStackTextModelForRole: () => testModel,
}));

const {
  generateTanStackTextForRole,
  generateTanStackObjectForRole,
  mergeGenerationOptions,
  streamTanStackTextForRole,
  streamTanStackObjectForRole,
} = await import("@/api/lib/tanstack-ai-generate");

const testModel = {
  adapter: {},
  keySource: "instance",
  modelId: "test-model",
  modelOptions: {},
  provider: "openai",
};

const noCaching = {
  enabled: false,
  reason: "org-disabled",
} satisfies CachingDecision;

afterAll(() => {
  mock.restore();
});

describe("TanStack AI structured output generation", () => {
  test("converts Valibot schemas into TanStack JSON-schema-compatible schemas", () => {
    const tanStackSchema = toTanStackValibotSchema(
      v.strictObject({ answer: v.string() }),
    );

    const jsonSchema = realTanStackAI.convertSchemaToJsonSchema(tanStackSchema);

    if (!jsonSchema) {
      throw new TypeError("Expected TanStack to convert the schema.");
    }
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("answer");
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
    capturedChatOptions.length = 0;
    nextChatResult = { answer: "ok" };
    const rawSchema = v.strictObject({ answer: v.string() });

    const result = await generateTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
    });

    expect(result).toEqual({ answer: "ok" });
    const captured = getOnlyCapturedChatOptions();
    expect(captured.outputSchema).not.toBe(rawSchema);
    expectHasTanStackJsonSchema(captured.outputSchema);
  });

  test("passes converted Valibot schemas to TanStack streaming object generation", async () => {
    capturedChatOptions.length = 0;
    const rawSchema = v.strictObject({ answer: v.string() });
    nextChatResult = createStructuredOutputStream({
      object: { answer: "ok" },
      raw: '{"answer":"ok"}',
      textDeltas: ['{"answer":"ok"}'],
    });

    const events = [];
    for await (const event of streamTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: rawSchema,
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
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
    const captured = getOnlyCapturedChatOptions();
    expect(captured.stream).toBe(true);
    expect(captured.outputSchema).not.toBe(rawSchema);
    expectHasTanStackJsonSchema(captured.outputSchema);
  });

  test("validates final objects with the original Valibot schema", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = { answer: 123 };

    const validationFailure = await generateTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "standard",
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

  test("enables OpenAI prompt caching without sending a model-specific retention value", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge regression test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "gpt-5.4-mini",
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
    // gpt-5.4-mini rejects sampling overrides; the caller temperature
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
      modelOptions: {},
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
      modelOptions: {},
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

  test("retries retryable deferred OpenAI generation with the standard tier", async () => {
    capturedChatOptions.length = 0;
    nextChatError = Object.assign(new Error("OpenAI flex tier unavailable"), {
      isRetryable: true,
      statusCode: 429,
    });
    nextChatResult = { answer: "ok" };

    const result = await generateTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "chat",
      serviceTier: "flex",
    });

    expect(result).toEqual({ answer: "ok" });
    expect(capturedChatOptions).toHaveLength(2);
    expect(capturedChatOptions[0]?.modelOptions).toMatchObject({
      service_tier: "flex",
    });
    expect(capturedChatOptions[1]?.modelOptions).toMatchObject({
      service_tier: "default",
    });
  });

  test("does not retry non-retryable deferred OpenAI generation errors", async () => {
    capturedChatOptions.length = 0;
    nextChatResults.length = 0;
    const apiError = Object.assign(new Error("OpenAI request rejected"), {
      isRetryable: false,
      statusCode: 400,
    });
    nextChatError = apiError;

    const caught = await generateTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "chat",
      serviceTier: "flex",
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBe(apiError);
    expect(capturedChatOptions).toHaveLength(1);
  });

  test("retries deferred structured streams after control-only chunks", async () => {
    capturedChatOptions.length = 0;
    nextChatResults.length = 0;
    const apiError = Object.assign(new Error("OpenAI flex tier unavailable"), {
      isRetryable: true,
      statusCode: 429,
    });
    nextChatResults.push(
      createFailingControlOnlyStream(apiError),
      createStructuredOutputStream({
        object: { answer: "ok" },
        raw: '{"answer":"ok"}',
        textDeltas: ['{"answer":"ok"}'],
      }),
    );

    const events = [];
    for await (const event of streamTanStackObjectForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      outputSchema: v.strictObject({ answer: v.string() }),
      prompt: "Extract the answer.",
      role: "pdf",
      serviceTier: "flex",
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
    expect(capturedChatOptions).toHaveLength(2);
    expect(capturedChatOptions[0]?.modelOptions).toMatchObject({
      service_tier: "flex",
    });
    expect(capturedChatOptions[1]?.modelOptions).toMatchObject({
      service_tier: "default",
    });
  });
});

describe("TanStack AI text generation", () => {
  test("collects text through the error-aware streaming boundary", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["hello", " world"]);

    const output = await generateTanStackTextForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
    });

    expect(output).toBe("hello world");
    expect(getOnlyCapturedChatOptions().stream).toBeUndefined();
  });

  test("propagates provider run errors from collected text", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = createRunErrorStream({
      code: "invalid_request_error",
      message: "OpenAI rejected the request.",
    });

    const caught = await generateTanStackTextForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      prompt: "Say hello.",
      role: "chat",
      serviceTier: "standard",
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

  test("propagates provider run errors from streaming text", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = createRunErrorStream({
      code: "rate_limit_exceeded",
      message: "OpenAI rate limit exceeded.",
    });

    const consume = async (): Promise<void> => {
      for await (const _delta of streamTanStackTextForRole({
        caching: noCaching,
        organizationId: null,
        orgAIConfig: null,
        prompt: "Say hello.",
        role: "chat",
        serviceTier: "standard",
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

const captureChatOptions = (options: unknown): CapturedChatOptions => {
  if (!isRecord(options)) {
    throw new TypeError("Expected TanStack chat options object.");
  }

  return {
    modelOptions: options["modelOptions"],
    outputSchema: options["outputSchema"],
    stream: options["stream"],
  };
};

const getOnlyCapturedChatOptions = (): CapturedChatOptions => {
  const captured = capturedChatOptions.at(0);
  if (!captured || capturedChatOptions.length !== 1) {
    throw new Error("Expected exactly one TanStack chat call.");
  }
  return captured;
};

const expectHasTanStackJsonSchema = (schema: unknown): void => {
  if (!isRecord(schema)) {
    throw new TypeError("Expected a TanStack Standard JSON Schema object.");
  }
  const standard = schema["~standard"];
  if (!isRecord(standard)) {
    throw new TypeError("Expected schema to expose Standard Schema metadata.");
  }
  expect(standard["jsonSchema"]).toBeDefined();
};

const createStructuredOutputStream = async function* ({
  object,
  raw,
  textDeltas = [],
}: {
  object: unknown;
  raw: string;
  textDeltas?: string[];
}) {
  for (const delta of textDeltas) {
    yield {
      delta,
      type: realTanStackAI.EventType.TEXT_MESSAGE_CONTENT,
    };
  }

  yield {
    name: "structured-output.complete",
    type: realTanStackAI.EventType.CUSTOM,
    value: { object, raw },
  };
};

const createTextStream = async function* (deltas: string[]) {
  for (const delta of deltas) {
    yield {
      delta,
      type: realTanStackAI.EventType.TEXT_MESSAGE_CONTENT,
    };
  }
};

const createRunErrorStream = async function* ({
  code,
  message,
}: {
  code: string;
  message: string;
}) {
  yield {
    code,
    message,
    type: realTanStackAI.EventType.RUN_ERROR,
  };
};

const createFailingControlOnlyStream = async function* (error: Error) {
  yield {
    type: realTanStackAI.EventType.RUN_STARTED,
  };
  throw error;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
