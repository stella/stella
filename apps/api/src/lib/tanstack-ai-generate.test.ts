import * as realTanStackAI from "@tanstack/ai";
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import type { CachingDecision } from "@/api/lib/ai-config";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

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
  generateTanStackObjectForRole,
  mergeGenerationOptions,
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

  test("forwards deferred service tiers to Gemini requests", () => {
    // SAFETY: mergeGenerationOptions only reads provider/modelOptions/modelId.
    // The adapter is irrelevant for this pure option-merge test.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- focused pure helper test
    const model = {
      adapter: {},
      keySource: "instance",
      modelId: "gemini-3-pro-preview",
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

const createFailingControlOnlyStream = async function* (error: Error) {
  yield {
    type: realTanStackAI.EventType.RUN_STARTED,
  };
  throw error;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
