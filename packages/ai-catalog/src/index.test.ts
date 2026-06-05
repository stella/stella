import { describe, expect, test } from "bun:test";

import {
  AI_PROVIDERS,
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  BYOK_DEFAULT_MODELS,
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  MODEL_ROLES,
} from "./index";

const CUSTOM_PROVIDERS = new Set(["azure_foundry", "huggingface"]);

describe("DEFAULT_MODELS", () => {
  test("covers every provider and role", () => {
    for (const provider of AI_PROVIDERS) {
      const roles = DEFAULT_MODELS[provider];
      expect(roles).toBeDefined();
      for (const role of MODEL_ROLES) {
        expect(roles[role].length).toBeGreaterThan(0);
      }
    }
  });

  test("shares the BYOK defaults verbatim", () => {
    const byokProviders = [
      "google",
      "openrouter",
      "openai",
      "anthropic",
      "mistral",
    ] as const;
    for (const provider of byokProviders) {
      expect(DEFAULT_MODELS[provider]).toEqual(BYOK_DEFAULT_MODELS[provider]);
    }
  });
});

describe("BYOK_MODEL_OPTIONS", () => {
  test("excludes openai_compatible and lists curated models for cloud providers", () => {
    expect("openai_compatible" in BYOK_MODEL_OPTIONS).toBe(false);
    for (const [provider, models] of Object.entries(BYOK_MODEL_OPTIONS)) {
      if (CUSTOM_PROVIDERS.has(provider)) {
        expect(models).toHaveLength(0);
      } else {
        expect(models.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("anthropic adaptive thinking", () => {
  // The reasoning role enables adaptive thinking; newer Claude models
  // reject the legacy budget form, so the reasoning default — and any
  // offered Claude model selected for reasoning — must be in the
  // adaptive set or it 400s at call time.
  const isAdaptive = (modelId: string): boolean =>
    ANTHROPIC_ADAPTIVE_THINKING_MODELS.some((m) => modelId.includes(m));

  test("the anthropic reasoning default supports adaptive thinking", () => {
    expect(isAdaptive(DEFAULT_MODELS.anthropic.reasoning)).toBe(true);
  });

  test("every adaptive model is actually offered to users", () => {
    for (const model of ANTHROPIC_ADAPTIVE_THINKING_MODELS) {
      expect(
        BYOK_MODEL_OPTIONS.anthropic.some((offered) => offered.includes(model)),
      ).toBe(true);
    }
  });
});
