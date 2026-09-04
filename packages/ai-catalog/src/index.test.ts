import { describe, expect, test } from "bun:test";

import type { ReasoningEffort } from "./index";
import {
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  BYOK_DEFAULT_MODELS,
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  isChatPdfAttachmentModelSupported,
  CONTEXT_WINDOW_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  getContextWindowTokens,
  getModelDisplayMetadata,
  getModelRate,
  getModelReasoningEfforts,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  DEFAULT_MODELS,
  MODEL_DEFAULT_REASONING_EFFORTS,
  MODEL_RATES,
  MODEL_REASONING_EFFORTS,
  MODEL_TEMPERATURE_POLICIES,
  MODEL_ROLES,
  REASONING_EFFORTS,
  resolveReasoningEffort,
  resolveWorkingBYOKModelForRole,
  shouldEmitTemperature,
  TANSTACK_AI_PROVIDERS,
} from "./index";

const FLOATING_GOOGLE_MODEL_POINTERS = [
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
] as const;

const DIRECT_GPT_56_MODEL_IDS = [
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

const DIRECT_GPT_56_DISPLAY_NAMES = {
  "gpt-5.6": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
} as const satisfies Record<(typeof DIRECT_GPT_56_MODEL_IDS)[number], string>;

describe("direct OpenAI GPT-5.6 family", () => {
  test("exposes every tier with complete catalog metadata", () => {
    expect(
      BYOK_MODEL_OPTIONS.openai.filter((modelId) =>
        modelId.startsWith("gpt-5.6"),
      ),
    ).toEqual([...DIRECT_GPT_56_MODEL_IDS]);

    for (const modelId of DIRECT_GPT_56_MODEL_IDS) {
      const displayName = DIRECT_GPT_56_DISPLAY_NAMES[modelId];
      expect(getModelDisplayMetadata(modelId)).toEqual({
        displayName,
        iconProvider: "openai",
      });
      expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.openai).toContain(modelId);
      expect(MODEL_REASONING_EFFORTS[modelId]).toEqual([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(MODEL_DEFAULT_REASONING_EFFORTS[modelId]).toBeNull();
      expect(MODEL_TEMPERATURE_POLICIES[modelId]).toBe("omit");
      expect(getModelRate(modelId)).toBeDefined();
      expect(getContextWindowTokens(modelId)).toBe(922_000);
    }

    // OpenAI documents gpt-5.6 as an alias for Sol; both forms must resolve
    // to the same executable metadata while the picker shows the product name.
    expect(getModelDisplayMetadata("gpt-5.6-sol")).toEqual({
      displayName: "GPT-5.6 Sol",
      iconProvider: "openai",
    });
    expect(getModelRate("gpt-5.6-sol")).toBe(getModelRate("gpt-5.6"));
    expect(getContextWindowTokens("gpt-5.6-sol")).toBe(
      getContextWindowTokens("gpt-5.6"),
    );
  });
});

describe("BYOK provider role support", () => {
  test("does not route PDF flows through Mistral document-unsupported models", () => {
    expect(
      isBYOKProviderRoleSupported({ provider: "mistral", role: "chat" }),
    ).toBe(true);
    expect(
      isBYOKProviderRoleSupported({ provider: "mistral", role: "pdf" }),
    ).toBe(false);
  });

  test("PDF chat attachments accept a superset that adds Mistral vision models", () => {
    // Distinct from the pdf ROLE: this set only answers whether a PDF chat
    // attachment survives the adapter. Mistral is intentionally absent from
    // the pdf role above but its vision models accept PDF chat attachments, so
    // the chat-attachment set is a strict superset for Mistral and identical
    // elsewhere.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      const roleModels: readonly string[] =
        BYOK_DOCUMENT_INPUT_MODEL_OPTIONS[provider];
      const attachmentModels: readonly string[] =
        CHAT_PDF_ATTACHMENT_MODEL_OPTIONS[provider];
      for (const modelId of roleModels) {
        expect(attachmentModels).toContain(modelId);
      }
    }
    expect(
      isChatPdfAttachmentModelSupported({
        provider: "mistral",
        modelId: "mistral-medium-latest",
      }),
    ).toBe(true);
    expect(
      isChatPdfAttachmentModelSupported({
        provider: "mistral",
        modelId: "mistral-large-latest",
      }),
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
  // dropped zero, or a cache-read rate above the fresh-input rate mis-meters
  // every call for that model — silently over/under-charging the ledger.
  // The sourced-rate check validates against external catalogs, not these
  // internal economic invariants.
  for (const [modelId, rate] of Object.entries(MODEL_RATES)) {
    test(`${modelId}: prices preserve economic ordering`, () => {
      const amounts =
        rate.kind === "flat" ? [rate] : [rate.standard, rate.aboveThreshold];
      for (const amount of amounts) {
        expect(amount.inputPerMTok).toBeGreaterThan(0);
        expect(amount.outputPerMTok).toBeGreaterThanOrEqual(
          amount.inputPerMTok,
        );
        if ("cachedInputPerMTok" in amount) {
          expect(amount.cachedInputPerMTok).toBeGreaterThan(0);
          // Cache reads must never cost more than fresh input, or caching
          // becomes a price penalty (computeRawUsageMicroUnits assumes the
          // opposite).
          expect(amount.cachedInputPerMTok).toBeLessThanOrEqual(
            amount.inputPerMTok,
          );
        }
        if ("cachedWriteInputPerMTok" in amount) {
          expect(amount.cachedWriteInputPerMTok).toBeGreaterThanOrEqual(
            amount.inputPerMTok,
          );
        }
        expect(Number.isFinite(amount.outputPerMTok)).toBe(true);
      }
      if (rate.kind === "input-token-tiered") {
        expect(rate.inputTokenThreshold).toBeGreaterThan(0);
        expect(Number.isInteger(rate.inputTokenThreshold)).toBe(true);
        expect(rate.aboveThreshold.inputPerMTok).toBeGreaterThanOrEqual(
          rate.standard.inputPerMTok,
        );
        expect(rate.aboveThreshold.outputPerMTok).toBeGreaterThanOrEqual(
          rate.standard.outputPerMTok,
        );
      }
    });
  }

  test("canonical provider aliases share one rate schedule", () => {
    expect(getModelRate("gpt-5.6-sol")).toBe(getModelRate("gpt-5.6"));
    expect(getModelRate("google/gemini-3.7-flash")).toBe(
      getModelRate("gemini-3.7-flash"),
    );
    expect(getModelRate("google/gemini-3.8-flash")).toBe(
      getModelRate("gemini-3.8-flash"),
    );
  });

  test("floating provider pointers do not inherit fixed-model metadata", () => {
    for (const modelId of FLOATING_GOOGLE_MODEL_POINTERS) {
      expect(getModelRate(modelId)).toBeUndefined();
      expect(getContextWindowTokens(modelId)).toBe(
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      );
      expect(getModelReasoningEfforts(modelId)).toBeNull();
      expect(shouldEmitTemperature(modelId)).toBe(false);
    }
  });
});

describe("CONTEXT_WINDOW_TOKENS", () => {
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

  test("canonical provider aliases share context metadata", () => {
    expect(getContextWindowTokens("gpt-5.6-sol")).toBe(
      getContextWindowTokens("gpt-5.6"),
    );
  });
});

describe("MODEL_REASONING_EFFORTS", () => {
  test("canonical provider aliases share reasoning metadata", () => {
    expect(getModelReasoningEfforts("gpt-5.6-sol")).toEqual(
      getModelReasoningEfforts("gpt-5.6"),
    );
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

describe("MODEL_TEMPERATURE_POLICIES", () => {
  test("shouldEmitTemperature follows declared policy and denies unknown ids", () => {
    expect(shouldEmitTemperature("gemini-3.5-flash")).toBe(true);
    expect(shouldEmitTemperature("gemini-3.6-flash")).toBe(false);
    expect(shouldEmitTemperature("google/gemini-3.6-flash")).toBe(false);
    expect(shouldEmitTemperature("gemini-3.5-flash-lite")).toBe(false);
    // Newest GPT-5 and Claude models reject sampling overrides.
    expect(shouldEmitTemperature("gpt-5.6")).toBe(false);
    expect(shouldEmitTemperature("openai/gpt-5.5")).toBe(false);
    expect(shouldEmitTemperature("claude-fable-5")).toBe(false);
    // Unknown ids: no positive evidence, no parameter.
    expect(shouldEmitTemperature("o3-mini")).toBe(false);
    expect(shouldEmitTemperature("some-env-override-model")).toBe(false);
    expect(shouldEmitTemperature("gpt-5.6-sol")).toBe(
      shouldEmitTemperature("gpt-5.6"),
    );
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
