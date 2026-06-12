import * as realTanStackAI from "@tanstack/ai";
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import type { CachingDecision } from "@/api/lib/ai-config";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

type CapturedChatOptions = {
  outputSchema?: unknown;
  stream?: unknown;
};

const capturedChatOptions: CapturedChatOptions[] = [];
let nextChatResult: unknown = { answer: "ok" };

const chat = (options: unknown): unknown => {
  capturedChatOptions.push(captureChatOptions(options));
  return nextChatResult;
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

const { generateTanStackObjectForRole, streamTanStackObjectForRole } =
  await import("@/api/lib/tanstack-ai-generate");

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
      throw new Error("Expected TanStack to convert the schema.");
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
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(validationFailure).toBeDefined();
  });
});

const captureChatOptions = (options: unknown): CapturedChatOptions => {
  if (!isRecord(options)) {
    throw new Error("Expected TanStack chat options object.");
  }

  return {
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
    throw new Error("Expected a TanStack Standard JSON Schema object.");
  }
  const standard = schema["~standard"];
  if (!isRecord(standard)) {
    throw new Error("Expected schema to expose Standard Schema metadata.");
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
