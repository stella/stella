import { describe, expect, test } from "bun:test";

import type { ReasoningEffort } from "./index";
import {
  AI_PROVIDERS,
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  BYOK_DEFAULT_MODELS,
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_MODEL_OPTIONS,
  CONTEXT_WINDOW_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  getContextWindowTokens,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  DEFAULT_MODELS,
  MODEL_RATES,
  MODEL_REASONING_EFFORTS,
  MODEL_ROLES,
  REASONING_EFFORTS,
  resolveReasoningEffort,
  resolveWorkingBYOKModelForRole,
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

describe("resolveWorkingBYOKModelForRole", () => {
  test("keeps a still-offered model unchanged", () => {
    const modelId = BYOK_MODEL_OPTIONS.google[0];
    expect(
      resolveWorkingBYOKModelForRole({
        provider: "google",
        modelId,
        role: "chat",
      }),
    ).toBe(modelId);
  });

  test("heals a dropped model to the provider's per-role default", () => {
    // `gemini-3-flash-preview` was a prior-catalog id, no longer offered.
    expect(
      resolveWorkingBYOKModelForRole({
        provider: "google",
        modelId: "gemini-3-flash-preview",
        role: "reasoning",
      }),
    ).toBe(BYOK_DEFAULT_MODELS.google.reasoning);
  });

  test("heals a dropped model on the pdf role to a document-capable default", () => {
    const healed = resolveWorkingBYOKModelForRole({
      provider: "google",
      modelId: "gemini-3-flash-preview",
      role: "pdf",
    });
    expect(healed).toBe(BYOK_DEFAULT_MODELS.google.pdf);
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.google).toContain(
      BYOK_DEFAULT_MODELS.google.pdf,
    );
  });

  test("every BYOK default is offered for its role (except mistral+pdf)", () => {
    // resolveWorkingBYOKModelForRole only returns null when even the
    // per-role default is not offered. That must stay a one-off
    // (mistral+pdf, which has no document-capable model): if a future
    // catalog edit drops a default from BYOK_MODEL_OPTIONS, healing would
    // silently stop and leave a stale model pinned. Catch that here.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const role of MODEL_ROLES) {
        const modelId = BYOK_DEFAULT_MODELS[provider][role];
        const resolved = resolveWorkingBYOKModelForRole({
          provider,
          modelId,
          role,
        });
        if (provider === "mistral" && role === "pdf") {
          expect(resolved).toBeNull();
        } else {
          expect(resolved).toBe(modelId);
        }
      }
    }
  });

  test("returns null for mistral + pdf: no document-capable model exists", () => {
    // The TanStack Mistral adapter exposes no `document` input modality,
    // so not even the default can serve the pdf role. Same-provider
    // healing is impossible; the caller must leave the selection as-is.
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.mistral).toHaveLength(0);
    expect(
      resolveWorkingBYOKModelForRole({
        provider: "mistral",
        modelId: "mistral-large-latest",
        role: "pdf",
      }),
    ).toBeNull();
  });

  test("mistral non-pdf roles still heal on the same provider", () => {
    expect(
      resolveWorkingBYOKModelForRole({
        provider: "mistral",
        modelId: "some-retired-mistral-id",
        role: "chat",
      }),
    ).toBe(BYOK_DEFAULT_MODELS.mistral.chat);
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

describe("CONTEXT_WINDOW_TOKENS", () => {
  // Every metered first-party model must declare a window, or the
  // per-model compaction trigger silently degrades to the conservative
  // default for a model users actively pick.
  test("covers every model with a ledger rate", () => {
    for (const modelId of Object.keys(MODEL_RATES)) {
      expect(CONTEXT_WINDOW_TOKENS[modelId]).toBeGreaterThan(0);
    }
  });

  test("windows are never below the conservative default", () => {
    for (const window of Object.values(CONTEXT_WINDOW_TOKENS)) {
      expect(window).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_WINDOW_TOKENS);
    }
  });

  test("falls back to the default for unlisted model IDs", () => {
    expect(getContextWindowTokens("speakleash/Bielik-11B-v2.3-Instruct")).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    expect(getContextWindowTokens("default")).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
  });

  test("returns the documented window for a listed model ID", () => {
    expect(getContextWindowTokens("claude-sonnet-4-6")).toBe(200_000);
    expect(getContextWindowTokens("gpt-5.4")).toBe(400_000);
  });
});

describe("MODEL_REASONING_EFFORTS", () => {
  test("declares every offered BYOK model", () => {
    for (const models of Object.values(BYOK_MODEL_OPTIONS)) {
      for (const modelId of models) {
        expect(
          MODEL_REASONING_EFFORTS[modelId],
          `missing reasoning capability for ${modelId}`,
        ).not.toBeUndefined();
      }
    }
  });

  test("declared effort lists are non-empty, deduplicated ladder values", () => {
    for (const [modelId, efforts] of Object.entries(MODEL_REASONING_EFFORTS)) {
      if (efforts === null) {
        continue;
      }
      expect(efforts.length, modelId).toBeGreaterThan(0);
      expect(new Set(efforts).size, modelId).toBe(efforts.length);
      for (const effort of efforts) {
        expect(REASONING_EFFORTS, `${modelId}: ${effort}`).toContain(effort);
      }
    }
  });
});

describe("resolveReasoningEffort", () => {
  // Widen the branded return type so literal expectations typecheck.
  const resolve = (
    modelId: string,
    requested: ReasoningEffort,
  ): ReasoningEffort | null => resolveReasoningEffort({ modelId, requested });

  test("passes a supported effort through unchanged", () => {
    expect(resolve("openai/gpt-5.5", "none")).toBe("none");
    expect(resolve("google/gemini-3.5-flash", "high")).toBe("high");
  });

  test("clamps a disabled-reasoning request on a reasoning-mandatory model to its weakest tier", () => {
    // The provider-502 class this table exists for: gemini-3.5-flash
    // rejects effort "none" outright.
    expect(resolve("google/gemini-3.5-flash", "none")).toBe("minimal");
    expect(resolve("gemini-3.1-pro-preview", "minimal")).toBe("low");
  });

  test("clamps a request above the model's ceiling down to it", () => {
    expect(resolve("google/gemini-3.1-pro-preview", "max")).toBe("high");
  });

  test("prefers the weaker side on equidistant ties", () => {
    // mistral-small-latest declares ["none", "high"]; "low" sits two
    // ladder steps from "none" and two from "high" — weaker side wins.
    expect(resolve("mistral-small-latest", "low")).toBe("none");
  });

  test("returns null for unknown models and models without an effort dial", () => {
    expect(resolve("some-env-override-model", "none")).toBeNull();
    expect(resolve("magistral-medium-latest", "high")).toBeNull();
    expect(resolve("claude-haiku-4-5-20251001", "low")).toBeNull();
  });
});
