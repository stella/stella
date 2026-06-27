import * as realTanStackAI from "@tanstack/ai";
import { describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";

// Capture the args each chat() call receives so we can assert whether the skill
// tools were wired and how the prompt was assembled. The model itself is
// irrelevant here (chat is mocked). Skill refs run the agentic tool loop, so the
// field generators call chat() directly; `tools` arrives as a ChatTool[] array.
type CapturedChat = {
  tools: { name: string }[] | undefined;
  prompt: string | undefined;
};

const chatArgs: CapturedChat[] = [];

const captureChat = (options: {
  tools?: { name: string }[];
  messages?: { content?: string }[];
  outputSchema?: unknown;
}): CapturedChat => ({
  tools: options.tools,
  prompt: options.messages?.at(0)?.content,
});

const chat = (options: {
  tools?: { name: string }[];
  messages?: { content?: string }[];
  outputSchema?: unknown;
}): unknown => {
  chatArgs.push(captureChat(options));
  if (options.outputSchema) {
    return Promise.resolve({ renderings: ["adapted"] });
  }
  return Promise.resolve("drafted value");
};

const testModel = {
  adapter: {},
  keySource: "instance",
  modelId: "test-model",
  modelOptions: {},
  provider: "openai",
};

void mock.module("@tanstack/ai", () => ({
  ...realTanStackAI,
  chat,
}));

void mock.module("@/api/lib/tanstack-ai-models", () => ({
  ...realTanStackAIModels,
  getTanStackTextModelForRole: () => testModel,
  hasTanStackInstanceProvider: () => false,
}));

const { buildAiFieldGenerator, buildAiOccurrenceAdapter } =
  await import("@/api/handlers/docx/ai-field-generator");

// SAFETY: only used as a non-null truthiness gate in the builders; the model
// is mocked, so the config's contents are never read.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const orgAIConfig = {} as OrgAIConfig;
const organizationId = toSafeId<"organization">("org_test");
const userId = toSafeId<"user">("user_test");
// SAFETY: never invoked — the skill tools build lazily and the model is mocked.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const safeDb = (async () => undefined) as unknown as SafeDb;
const skillContext = { organizationId, safeDb, userId };

const SKILL_REF_PROMPT =
  "Draft this clause [POA scope](#stella-skill-ref=poa-drafting).";
const PLAIN_PROMPT = "Draft the scope of this power of attorney.";

const lastChat = () => chatArgs.at(-1);
const lastToolNames = () => (lastChat()?.tools ?? []).map((tool) => tool.name);

describe("buildAiFieldGenerator skill-tool wiring", () => {
  test("wires load-skill tools when the prompt references a skill", async () => {
    const generate = buildAiFieldGenerator({
      orgAIConfig,
      organizationId,
      skillContext,
    });
    expect(generate).toBeDefined();
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    expect(lastChat()?.tools).toBeDefined();
    expect(lastToolNames()).toEqual(["load-skill", "read-skill-resource"]);
  });

  test("passes no tools when the prompt has no skill reference", async () => {
    const generate = buildAiFieldGenerator({
      orgAIConfig,
      organizationId,
      skillContext,
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastChat()?.tools).toBeUndefined();
  });

  test("passes no tools without a skill context, even with a ref", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    expect(lastChat()?.tools).toBeUndefined();
  });
});

describe("buildAiFieldGenerator document-text injection", () => {
  test("injects a Document section when documentText is supplied", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "THE FULL CONTRACT BODY",
    });

    const prompt = lastChat()?.prompt ?? "";
    expect(prompt).toContain("Document:\nTHE FULL CONTRACT BODY");
  });

  test("omits the Document section when no documentText is supplied", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastChat()?.prompt ?? "").not.toContain("Document:");
  });

  test("omits the Document section for blank documentText", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "   ",
    });

    expect(lastChat()?.prompt ?? "").not.toContain("Document:");
  });
});

describe("buildAiOccurrenceAdapter skill-tool wiring", () => {
  const occurrences = [{ context: "see {{scope}} herein" }];

  test("wires load-skill tools when the instruction references a skill", async () => {
    const adapt = buildAiOccurrenceAdapter({
      orgAIConfig,
      organizationId,
      skillContext,
    });
    expect(adapt).toBeDefined();
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: SKILL_REF_PROMPT,
      occurrences,
    });

    expect(lastChat()?.tools).toBeDefined();
    expect(lastToolNames()).toEqual(["load-skill", "read-skill-resource"]);
  });

  test("passes no tools when the instruction has no skill reference", async () => {
    const adapt = buildAiOccurrenceAdapter({
      orgAIConfig,
      organizationId,
      skillContext,
    });
    await adapt?.({
      stub: "the scope",
      fieldPath: "scope",
      label: "Scope",
      prompt: PLAIN_PROMPT,
      occurrences,
    });

    expect(lastChat()?.tools).toBeUndefined();
  });
});
