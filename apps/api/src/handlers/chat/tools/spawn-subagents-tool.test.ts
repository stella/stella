import { describe, expect, test } from "bun:test";

import { resolveValidatedSubagentModelId } from "@/api/handlers/chat/tools/spawn-subagents-tool";

// `resolveValidatedSubagentModelId` is the allowlist that stops a
// model-generated `sub.model` override from running an arbitrary (and
// possibly expensive) model. These cases guard the real security
// properties described in its docstring: provider-qualified overrides are
// rejected outright, BYOK overrides must be in the curated per-provider
// catalog, and platform-key ("instance") overrides must match the
// configured model exactly.

describe("resolveValidatedSubagentModelId", () => {
  test("returns undefined when no override is supplied", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: undefined,
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("rejects a provider-qualified override ('provider::model') even under BYOK", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "openrouter::google/gemini-3.5-flash",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("accepts a BYOK override that is in the provider's curated catalog", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-sonnet-4-6",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBe("claude-sonnet-4-6");
  });

  test("rejects a BYOK override that is not in the provider's curated catalog", () => {
    const modelId = resolveValidatedSubagentModelId({
      // A real model id, but from a different provider's catalog.
      subModel: "gpt-5.4-nano",
      modelInfo: {
        keySource: "byok",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    });

    expect(modelId).toBeUndefined();
  });

  test("accepts an instance override that matches the configured model exactly", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-sonnet-4-6",
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBe("claude-sonnet-4-6");
  });

  test("rejects an instance override that does not match the configured model", () => {
    const modelId = resolveValidatedSubagentModelId({
      subModel: "claude-opus-4-8",
      modelInfo: {
        keySource: "instance",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    });

    expect(modelId).toBeUndefined();
  });
});
