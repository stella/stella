import { describe, expect, test } from "bun:test";

import {
  AI_PROVIDERS,
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  BYOK_DEFAULT_MODELS,
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_MODEL_OPTIONS,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  DEFAULT_MODELS,
  MODEL_RATES,
  MODEL_ROLES,
  TANSTACK_AI_PROVIDERS,
} from "./index";

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
    for (const provider of TANSTACK_AI_PROVIDERS) {
      expect(DEFAULT_MODELS[provider]).toEqual(BYOK_DEFAULT_MODELS[provider]);
    }
  });
});

describe("BYOK_MODEL_OPTIONS", () => {
  test("only lists TanStack-supported BYOK providers", () => {
    expect(Object.keys(BYOK_MODEL_OPTIONS).sort()).toEqual(
      [...TANSTACK_AI_PROVIDERS].sort(),
    );
    expect("openai_compatible" in BYOK_MODEL_OPTIONS).toBe(false);
    expect("azure_foundry" in BYOK_MODEL_OPTIONS).toBe(false);
    expect("huggingface" in BYOK_MODEL_OPTIONS).toBe(false);
    for (const models of Object.values(BYOK_MODEL_OPTIONS)) {
      expect(models.length).toBeGreaterThan(0);
    }
  });
});

describe("BYOK provider role support", () => {
  test("documents the curated PDF-capable model set", () => {
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.google).toContain(
      "gemini-3.5-flash",
    );
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.openrouter).toContain(
      "google/gemini-3.5-flash",
    );
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.bedrock).toContain(
      "us.amazon.nova-pro-v1:0",
    );
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.openai).toContain("gpt-5.4");
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.mistral).toEqual([]);
  });

  test("does not route PDF flows through Mistral document-unsupported models", () => {
    expect(
      isBYOKProviderRoleSupported({ provider: "mistral", role: "chat" }),
    ).toBe(true);
    expect(
      isBYOKProviderRoleSupported({ provider: "mistral", role: "pdf" }),
    ).toBe(false);
  });

  test("does not route PDF flows through Bedrock text-only models", () => {
    expect(
      isBYOKModelRoleSupported({
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        role: "pdf",
      }),
    ).toBe(true);
    expect(
      isBYOKModelRoleSupported({
        provider: "bedrock",
        modelId: "us.amazon.nova-pro-v1:0",
        role: "pdf",
      }),
    ).toBe(true);
    expect(
      isBYOKModelRoleSupported({
        provider: "bedrock",
        modelId: "openai.gpt-oss-120b-1:0",
        role: "pdf",
      }),
    ).toBe(false);
    expect(
      isBYOKModelRoleSupported({
        provider: "bedrock",
        modelId: "us.deepseek.r1-v1:0",
        role: "pdf",
      }),
    ).toBe(false);
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

describe("MODEL_RATES economic ordering", () => {
  // `satisfies Record<..., ModelRate>` only proves the numeric fields
  // exist; it cannot prove their ordering. A transposed input/output, a
  // dropped zero, or a cached rate above the fresh-input rate mis-meters
  // every call for that model — silently over/under-charging the ledger.
  // The nightly upstream check validates against external catalogs, not
  // these internal invariants, and runs after the merge window.
  for (const [modelId, rate] of Object.entries(MODEL_RATES)) {
    test(`${modelId}: input>0, output>=input, 0<cached<=input`, () => {
      expect(rate.inputPerMTok).toBeGreaterThan(0);
      expect(rate.outputPerMTok).toBeGreaterThanOrEqual(rate.inputPerMTok);
      if (rate.cachedInputPerMTok !== undefined) {
        expect(rate.cachedInputPerMTok).toBeGreaterThan(0);
        // Cache reads must never cost more than fresh input, or caching
        // becomes a price penalty (computeRawUsageMicroUnits assumes the
        // opposite).
        expect(rate.cachedInputPerMTok).toBeLessThanOrEqual(rate.inputPerMTok);
      }
      expect(Number.isFinite(rate.outputPerMTok)).toBe(true);
    });
  }
});
