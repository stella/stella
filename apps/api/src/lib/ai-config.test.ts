import { describe, expect, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";

import { normalizeOrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";

const googleProvider = {
  provider: "google",
  apiKey: "test-key",
  region: "global",
} as const;

const mistralProvider = {
  provider: "mistral",
  apiKey: "test-key",
  region: "global",
} as const;

describe("normalizeOrgAIConfig auto-heal", () => {
  test("rewrites models dropped by a catalog bump to the same-provider default", () => {
    const config: OrgAIConfig = {
      providers: [googleProvider],
      overrideModels: {
        fast: { provider: "google", modelId: "gemini-2.5-flash-lite" },
        chat: { provider: "google", modelId: "gemini-3-flash-preview" },
        reasoning: { provider: "google", modelId: "gemini-3-pro-preview" },
        pdf: { provider: "google", modelId: "gemini-3-flash-preview" },
      },
    };

    const healed = normalizeOrgAIConfig(config).overrideModels;

    expect(healed.fast).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.fast,
    });
    expect(healed.chat).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.chat,
    });
    expect(healed.reasoning).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.reasoning,
    });
    expect(healed.pdf).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.pdf,
    });
  });

  test("leaves still-offered models untouched", () => {
    const config: OrgAIConfig = {
      providers: [googleProvider],
      overrideModels: {
        fast: { provider: "google", modelId: BYOK_DEFAULT_MODELS.google.fast },
        chat: { provider: "google", modelId: BYOK_DEFAULT_MODELS.google.chat },
        reasoning: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.reasoning,
        },
        pdf: { provider: "google", modelId: BYOK_DEFAULT_MODELS.google.pdf },
      },
    };

    expect(normalizeOrgAIConfig(config).overrideModels).toEqual(
      config.overrideModels,
    );
  });

  test("leaves mistral + pdf unhealable selection as-is (no document-capable model)", () => {
    const staleMistralPdf = {
      provider: "mistral",
      modelId: "mistral-large-latest",
    } as const;
    const config: OrgAIConfig = {
      providers: [mistralProvider],
      overrideModels: {
        fast: { provider: "mistral", modelId: "some-retired-mistral-id" },
        chat: { provider: "mistral", modelId: "some-retired-mistral-id" },
        reasoning: { provider: "mistral", modelId: "some-retired-mistral-id" },
        pdf: staleMistralPdf,
      },
    };

    const healed = normalizeOrgAIConfig(config).overrideModels;

    // fast/chat/reasoning heal on the same provider...
    expect(healed.fast.modelId).toBe(BYOK_DEFAULT_MODELS.mistral.fast);
    expect(healed.chat.modelId).toBe(BYOK_DEFAULT_MODELS.mistral.chat);
    expect(healed.reasoning.modelId).toBe(
      BYOK_DEFAULT_MODELS.mistral.reasoning,
    );
    // ...but pdf cannot be healed to the same provider, so it is untouched.
    expect(healed.pdf).toEqual(staleMistralPdf);
  });

  test("leaves a non-BYOK provider selection untouched", () => {
    // A provider with no first-class BYOK adapter (e.g. huggingface) has
    // nothing to heal to on the same provider, so the selection passes
    // through and surfaces via generation-time validation instead.
    const staleHuggingFace = {
      provider: "huggingface",
      modelId: "speakleash/Bielik-11B-v2.3-Instruct",
    } as const;
    const config: OrgAIConfig = {
      providers: [googleProvider],
      overrideModels: {
        fast: staleHuggingFace,
        chat: { provider: "google", modelId: BYOK_DEFAULT_MODELS.google.chat },
        reasoning: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.reasoning,
        },
        pdf: { provider: "google", modelId: BYOK_DEFAULT_MODELS.google.pdf },
      },
    };

    expect(normalizeOrgAIConfig(config).overrideModels.fast).toEqual(
      staleHuggingFace,
    );
  });
});
