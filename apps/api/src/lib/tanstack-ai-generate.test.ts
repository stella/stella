import * as realTanStackAI from "@tanstack/ai";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  MODEL_ROLES,
  REASONING_EFFORTS,
} from "@stll/ai-catalog";

import type { CachingDecision } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";
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

type CapturedChatOptions = {
  messages?: unknown;
  modelOptions?: unknown;
  outputSchema?: unknown;
  stream?: unknown;
  systemPrompts?: unknown;
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

let analytics: RecordingAnalytics;
let logs: RecordingLogger;

beforeEach(() => {
  analytics = installRecordingAnalytics();
  logs = installRecordingLogger();
});

afterEach(() => {
  analytics.restore();
  logs.restore();
});

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

  test("keeps trim normalization outside the provider JSON schema", () => {
    const rawSchema = v.strictObject({
      answer: v.pipe(v.string(), v.trim(), v.minLength(1)),
    });
    const tanStackSchema = toTanStackValibotSchema(rawSchema);

    const jsonSchema = realTanStackAI.convertSchemaToJsonSchema(tanStackSchema);

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

    expect(() =>
      realTanStackAI.convertSchemaToJsonSchema(tanStackSchema),
    ).toThrow('The "to_lower_case" action cannot be converted to JSON Schema.');
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
      tenantWorkspaceIds: [],
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
      tenantWorkspaceIds: [],
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
      tenantWorkspaceIds: [],
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
    expect(capturedChatOptions).toHaveLength(2);
    expect(capturedChatOptions[0]?.modelOptions).toMatchObject({
      service_tier: "flex",
    });
    expect(capturedChatOptions[1]?.modelOptions).toMatchObject({
      service_tier: "default",
    });
  });
});

// Every non-chat model call in the API dispatches through this module, so the
// guard has to run here rather than at each of the ~25 call sites. These pin
// the wiring against the real guard: the provider stub records exactly what a
// provider would have received.
describe("TanStack AI model-ingress guard", () => {
  const tenantWorkspaceId = toSafeId<"workspace">(
    "0dc54d0c-10d7-501d-897e-e801dbd0998c",
  );
  const publicDecisionId = "7c0f7d51-70a4-4d64-9f0e-0a4d64e9911b";

  test("redacts tenant ids out of the dispatched messages", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["ok"]);

    await generateTanStackTextForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      prompt: `Summarize https://my.stll.app/workspaces/${tenantWorkspaceId}/matters and decision ${publicDecisionId}`,
      role: "chat",
      serviceTier: "standard",
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    const dispatched = JSON.stringify(getOnlyCapturedChatOptions().messages);
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
    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["ok"]);

    await generateTanStackTextForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      prompt: `Summarize decision ${publicDecisionId}`,
      role: "chat",
      serviceTier: "standard",
      system: "You are stella.",
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    const captured = getOnlyCapturedChatOptions();
    expect(JSON.stringify(captured.messages)).toContain(publicDecisionId);
    expect(JSON.stringify(captured.messages)).not.toContain(
      "[internal-id-removed]",
    );
    expect(captured.systemPrompts).toEqual(["You are stella."]);
    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("WARN")).toEqual([]);
  });

  test("redacts an untrusted-embedding system prompt, fails closed on a server-built one", async () => {
    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["ok"]);

    await generateTanStackTextForRole({
      caching: noCaching,
      organizationId: null,
      orgAIConfig: null,
      prompt: "Draft it.",
      role: "chat",
      serviceTier: "standard",
      system: `Document context: workspace ${tenantWorkspaceId}`,
      tenantWorkspaceIds: [tenantWorkspaceId],
    });

    expect(getOnlyCapturedChatOptions().systemPrompts).toEqual([
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

    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["ok"]);
    const serverBuiltFailure = await generateTanStackTextForRole({
      caching: noCaching,
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
    expect(capturedChatOptions).toHaveLength(0);
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
    capturedChatOptions.length = 0;
    nextChatResult = createTextStream(["partial"], "length");

    const caught = await generateTanStackTextForRole({
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
      tenantWorkspaceIds: [],
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
          const modelOptions = realTanStackAIModels.tanStackModelOptionsForRole(
            {
              modelId,
              organizationId: null,
              provider: "anthropic",
              reasoningEffort,
              role,
            },
          );
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

          const budget =
            modelOptions.thinking?.type === "enabled"
              ? modelOptions.thinking.budget_tokens
              : 0;
          expect(merged["max_tokens"]).toBeGreaterThan(budget);
        }
      }
    }
  });
});

const captureChatOptions = (options: unknown): CapturedChatOptions => {
  if (!isRecord(options)) {
    throw new TypeError("Expected TanStack chat options object.");
  }

  return {
    messages: options["messages"],
    modelOptions: options["modelOptions"],
    outputSchema: options["outputSchema"],
    stream: options["stream"],
    systemPrompts: options["systemPrompts"],
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

const createTextStream = async function* (
  deltas: string[],
  finishReason?: "stop" | "length",
) {
  for (const delta of deltas) {
    yield {
      delta,
      type: realTanStackAI.EventType.TEXT_MESSAGE_CONTENT,
    };
  }
  if (finishReason) {
    yield {
      type: realTanStackAI.EventType.RUN_FINISHED,
      finishReason,
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
