import type { ToolSet } from "ai";
import { describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { toSafeId } from "@/api/lib/branded-types";

// Capture the args each generate/stream call receives so we can assert whether
// the skill tools were wired. The model itself is irrelevant here (mocked).
const generateTextMock = mock(
  async (args: { tools?: ToolSet; prompt?: string }) => {
    generateTextArgs.push(args);
    return { text: "drafted value" };
  },
);

const streamTextMock = mock((args: { tools?: ToolSet; prompt?: string }) => {
  streamTextArgs.push(args);
  return { output: Promise.resolve({ renderings: ["adapted"] }) };
});

const generateTextArgs: { tools?: ToolSet; prompt?: string }[] = [];
const streamTextArgs: { tools?: ToolSet; prompt?: string }[] = [];

void mock.module("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  Output: { object: () => ({}) },
  stepCountIs: (n: number) => n,
  tool: (config: unknown) => config,
}));

void mock.module("@/api/lib/ai-models", () => ({
  getModelForRole: () => ({ modelId: "test-model" }),
}));

void mock.module("@/api/lib/ai-output-schema", () => ({
  strictOutputSchema: (schema: unknown) => schema,
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

const lastGenerate = () => generateTextArgs.at(-1);
const lastStream = () => streamTextArgs.at(-1);

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

    const args = lastGenerate();
    expect(args?.tools).toBeDefined();
    expect(Object.keys(args?.tools ?? {})).toEqual([
      "load-skill",
      "read-skill-resource",
    ]);
  });

  test("passes no tools when the prompt has no skill reference", async () => {
    const generate = buildAiFieldGenerator({
      orgAIConfig,
      organizationId,
      skillContext,
    });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastGenerate()?.tools).toBeUndefined();
  });

  test("passes no tools without a skill context, even with a ref", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({
      prompt: SKILL_REF_PROMPT,
      fieldPath: "scope",
      values: {},
    });

    expect(lastGenerate()?.tools).toBeUndefined();
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

    const prompt = lastGenerate()?.prompt ?? "";
    expect(prompt).toContain("Document:\nTHE FULL CONTRACT BODY");
  });

  test("omits the Document section when no documentText is supplied", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({ prompt: PLAIN_PROMPT, fieldPath: "scope", values: {} });

    expect(lastGenerate()?.prompt ?? "").not.toContain("Document:");
  });

  test("omits the Document section for blank documentText", async () => {
    const generate = buildAiFieldGenerator({ orgAIConfig, organizationId });
    await generate?.({
      prompt: PLAIN_PROMPT,
      fieldPath: "scope",
      values: {},
      documentText: "   ",
    });

    expect(lastGenerate()?.prompt ?? "").not.toContain("Document:");
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

    const args = lastStream();
    expect(args?.tools).toBeDefined();
    expect(Object.keys(args?.tools ?? {})).toEqual([
      "load-skill",
      "read-skill-resource",
    ]);
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

    expect(lastStream()?.tools).toBeUndefined();
  });
});
