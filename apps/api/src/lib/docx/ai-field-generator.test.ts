import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { beforeEach, describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import {
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

// The real `chat()` engine runs here; only the provider boundary is faked, so
// a fixture cannot invent chunk shapes the engine never emits. Each request the
// engine dispatches is captured so we can assert whether the skill tools were
// wired and how the prompt was assembled. Text drafting reaches the adapter
// through `chatStream`; the occurrence adapter asks for structured output, and
// with no skill tools the engine skips the agent loop and calls
// `structuredOutput` alone.
type CapturedRequest = {
  prompt: string | undefined;
  toolNames: string[];
};

const capturedRequests: CapturedRequest[] = [];

const captureRequest = ({
  messages,
  tools,
}: {
  messages?: readonly { content?: unknown }[] | undefined;
  tools?: readonly { name: string }[] | undefined;
}): void => {
  const content = messages?.at(0)?.content;
  capturedRequests.push({
    prompt: typeof content === "string" ? content : undefined,
    toolNames: (tools ?? []).map((tool) => tool.name),
  });
};

const DRAFTED_VALUE = "drafted value";
const ADAPTED_RENDERINGS = { renderings: ["adapted"] };

const providerAdapter: AnyTextAdapter = {
  kind: "text",
  name: "field-generator",
  model: "test-model",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream(options) {
    captureRequest(options);
    const messageId = "provider-message-1";
    yield {
      type: EventType.RUN_STARTED,
      runId: "run-1",
      threadId: "thread-1",
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: DRAFTED_VALUE,
    } satisfies StreamChunk;
    yield { type: EventType.TEXT_MESSAGE_END, messageId } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      finishReason: "stop",
      runId: "run-1",
      threadId: "thread-1",
    } satisfies StreamChunk;
  },
  structuredOutput: async ({ chatOptions }) => {
    captureRequest(chatOptions);
    return {
      data: ADAPTED_RENDERINGS,
      rawText: JSON.stringify(ADAPTED_RENDERINGS),
    };
  },
};

// SAFETY: `adapter` is a real `AnyTextAdapter` the engine drives exactly as it
// drives a provider; the remaining fields are bookkeeping these generators
// never route through a provider.
const testModel = {
  adapter: providerAdapter,
  keySource: "instance",
  modelId: "test-model",
  modelOptions: {},
  provider: "openai",
} as ResolvedTanStackTextModel;

const resolveTextModel = () => testModel;

beforeEach(() => {
  capturedRequests.length = 0;
});

// SAFETY: only used as a non-null truthiness gate in the builders; the model is
// injected through `resolveTextModel`, so the config's contents are never read.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const orgAIConfig = {} as OrgAIConfig;
const organizationId = toSafeId<"organization">("org_test");
const userId = toSafeId<"user">("user_test");
// SAFETY: never invoked — the skill catalog is empty here, so no skill tool is
// ever built or run.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const safeDb = (async () => undefined) as unknown as SafeDb;
const skillContext = { organizationId, safeDb, userId };

const SKILL_REF_PROMPT =
  "Draft this clause [POA scope](#stella-skill-ref=poa-drafting).";
const PLAIN_PROMPT = "Draft the scope of this power of attorney.";

// The generators swallow model failures and return `undefined`, so an absent
// request has to fail loudly rather than read as "no tools were advertised".
const lastRequest = (): CapturedRequest => {
  const captured = capturedRequests.at(-1);
  if (!captured) {
    throw new Error("Expected the generator to reach the provider adapter.");
  }
  return captured;
};
const buildTestAiFieldGenerator = (
  options: Parameters<typeof buildAiFieldGenerator>[0],
) => buildAiFieldGenerator({ ...options, resolveTextModel });
const buildTestAiOccurrenceAdapter = (
  options: Parameters<typeof buildAiOccurrenceAdapter>[0],
) => buildAiOccurrenceAdapter({ ...options, resolveTextModel });

describe("buildAiFieldGenerator skill-tool wiring", () => {
  test("does not advertise skill tools for a ref when the catalog is empty", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    expect(generate).toBeDefined();
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    // The engine always hands the adapter a tool array; empty is what "no
    // skill tools were wired" looks like at the provider boundary.
    expect(lastRequest().toolNames).toEqual([]);
  });

  test("passes no tools when the prompt has no skill reference", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastRequest().toolNames).toEqual([]);
  });

  test("passes no tools without a skill context, even with a ref", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    expect(lastRequest().toolNames).toEqual([]);
  });
});

describe("buildAiFieldGenerator document-text injection", () => {
  test("injects a Document section when documentText is supplied", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "THE FULL CONTRACT BODY",
    });

    expect(lastRequest().prompt ?? "").toContain(
      "Document:\nTHE FULL CONTRACT BODY",
    );
  });

  test("omits the Document section when no documentText is supplied", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastRequest().prompt ?? "").not.toContain("Document:");
  });

  test("omits the Document section for blank documentText", async () => {
    const generate = buildTestAiFieldGenerator({
      orgAIConfig,
      organizationId,
      tenantWorkspaceIds: [],
    });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "   ",
    });

    expect(lastRequest().prompt ?? "").not.toContain("Document:");
  });
});

describe("buildAiOccurrenceAdapter skill-tool wiring", () => {
  const occurrences = [{ context: "see {{scope}} herein" }];

  test("does not advertise skill tools for a ref when the catalog is empty", async () => {
    const adapt = buildTestAiOccurrenceAdapter({
      orgAIConfig,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    expect(adapt).toBeDefined();
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: SKILL_REF_PROMPT,
      occurrences,
    });

    expect(lastRequest().toolNames).toEqual([]);
  });

  test("passes no tools when the instruction has no skill reference", async () => {
    const adapt = buildTestAiOccurrenceAdapter({
      orgAIConfig,
      organizationId,
      skillContext,
      tenantWorkspaceIds: [],
    });
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: PLAIN_PROMPT,
      occurrences,
    });

    expect(lastRequest().toolNames).toEqual([]);
  });
});
