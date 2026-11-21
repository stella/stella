import { describe, expect, test } from "bun:test";

import {
  BYOK_DEFAULT_MODELS,
  isBYOKProviderRoleSupported,
  MODEL_OVERRIDE_GROUPS,
  MODEL_TASKS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import {
  MODEL_DEFAULTS_LEDGER,
  resolveDefaultOverrideModels,
} from "@stll/ai-catalog/model-defaults-ledger";

import {
  normalizeOrgAIConfig,
  resolveOrgAIModel,
  resolveOrgAIModelForOverrideGroup,
  resolveOrgAIModelForTask,
} from "@/api/lib/ai-config";
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
      decision: null,
    };

    const healed = normalizeOrgAIConfig(config).overrideModels;

    expect(healed?.fast).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.fast.modelId,
    });
    expect(healed?.chat).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.chat.modelId,
    });
    expect(healed?.reasoning).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.reasoning.modelId,
    });
    expect(healed?.pdf).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.pdf.modelId,
    });
  });

  test("leaves still-offered models untouched", () => {
    const config: OrgAIConfig = {
      providers: [googleProvider],
      overrideModels: {
        fast: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.fast.modelId,
        },
        chat: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.chat.modelId,
        },
        reasoning: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.reasoning.modelId,
        },
        pdf: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.pdf.modelId,
        },
      },
      decision: null,
    };

    expect(normalizeOrgAIConfig(config).overrideModels).toEqual(
      config.overrideModels,
    );
  });

  test("keeps the selection of every role the catalog defines", () => {
    const defaults = resolveDefaultOverrideModels(["google"]);
    const overrideModels = Object.fromEntries(
      MODEL_OVERRIDE_GROUPS.map((role) => [role, defaults[role] ?? undefined]),
    );
    const config: OrgAIConfig = {
      providers: [googleProvider],
      overrideModels,
      decision: null,
    };

    const healed = normalizeOrgAIConfig(config).overrideModels;

    expect(Object.keys(healed ?? {}).toSorted()).toEqual(
      MODEL_OVERRIDE_GROUPS.toSorted(),
    );
    expect(healed).toEqual(overrideModels);
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
      decision: null,
    };

    const healed = normalizeOrgAIConfig(config).overrideModels;

    // fast/chat/reasoning heal on the same provider...
    expect(healed?.fast?.modelId).toBe(
      BYOK_DEFAULT_MODELS.mistral.fast.modelId,
    );
    expect(healed?.chat?.modelId).toBe(
      BYOK_DEFAULT_MODELS.mistral.chat.modelId,
    );
    expect(healed?.reasoning?.modelId).toBe(
      BYOK_DEFAULT_MODELS.mistral.reasoning.modelId,
    );
    // ...but pdf cannot be healed to the same provider, so it is untouched.
    expect(healed?.pdf).toEqual(staleMistralPdf);
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
        chat: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.chat.modelId,
        },
        reasoning: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.reasoning.modelId,
        },
        pdf: {
          provider: "google",
          modelId: BYOK_DEFAULT_MODELS.google.pdf.modelId,
        },
      },
      decision: null,
    };

    expect(normalizeOrgAIConfig(config).overrideModels?.fast).toEqual(
      staleHuggingFace,
    );
  });
});

describe("organization catalog defaults", () => {
  test("every provider and task resolves its canonical default without storing overrides", () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      const config = {
        providers: [{ provider, apiKey: "fixture-key" }],
        overrideModels: null,
        decision: null,
      } satisfies OrgAIConfig;
      for (const task of MODEL_TASKS) {
        const entry = MODEL_DEFAULTS_LEDGER[task][provider];
        if (entry.kind === "unsupported") {
          expect(resolveOrgAIModelForTask(config, task)).toBeNull();
        } else {
          expect(resolveOrgAIModelForTask(config, task)).toEqual({
            provider,
            modelId: entry.candidate.modelId,
          });
        }
      }
      expect(normalizeOrgAIConfig(config).overrideModels).toBeNull();
    }
  });
  test("a sparse custom selection stays custom and other roles use defaults", () => {
    const config = {
      providers: [googleProvider],
      overrideModels: {
        chat: { provider: "google", modelId: "gemini-3.8-flash" },
      },
      decision: null,
    } satisfies OrgAIConfig;
    expect(normalizeOrgAIConfig(config).overrideModels).toEqual(
      config.overrideModels,
    );
    expect(resolveOrgAIModelForTask(config, "short-text")).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.fast.modelId,
    });
  });
  test("browsing runs on the admin's pick, else on the org's fast model", () => {
    const fast = {
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
    } as const;
    const browse = {
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.chat.modelId,
    } as const;
    const fastDefault = resolveOrgAIModelForTask(
      { providers: [googleProvider], overrideModels: null, decision: null },
      "short-text",
    );
    // The custom fast pick differs from the catalog default, so following
    // the default instead of the pick would fail below.
    expect(fastDefault).not.toEqual(fast);
    expect(browse).not.toEqual(fast);

    const picked = {
      providers: [googleProvider],
      overrideModels: { fast, browse },
      decision: null,
    } satisfies OrgAIConfig;
    expect(resolveOrgAIModelForOverrideGroup(picked, "browse")).toEqual(browse);
    expect(resolveOrgAIModel(picked, { overrideGroup: "browse" })).toEqual(
      browse,
    );

    const fastOnly = {
      providers: [googleProvider],
      overrideModels: { fast },
      decision: null,
    } satisfies OrgAIConfig;
    expect(resolveOrgAIModelForOverrideGroup(fastOnly, "browse")).toEqual(fast);

    const none = {
      providers: [googleProvider],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    expect(resolveOrgAIModelForOverrideGroup(none, "browse")).toEqual(
      fastDefault,
    );
  });

  test("a role that owns its task resolves exactly as its task does", () => {
    const config = {
      providers: [googleProvider],
      overrideModels: {
        chat: { provider: "google", modelId: "gemini-3.1-pro-preview" },
      },
      decision: null,
    } satisfies OrgAIConfig;
    for (const task of MODEL_TASKS) {
      expect(resolveOrgAIModel(config, { task })).toEqual(
        resolveOrgAIModelForTask(config, task),
      );
    }
    expect(resolveOrgAIModelForOverrideGroup(config, "chat")).toEqual(
      resolveOrgAIModelForTask(config, "chat"),
    );
    expect(resolveOrgAIModelForOverrideGroup(config, "pdf")).toEqual(
      resolveOrgAIModelForTask(config, "pdf"),
    );
  });
  test("defaults use the first configured provider that supports the task", () => {
    const config = {
      providers: [mistralProvider, googleProvider],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    expect(
      isBYOKProviderRoleSupported({ provider: "mistral", role: "pdf" }),
    ).toBe(false);
    expect(resolveOrgAIModelForTask(config, "pdf")).toEqual({
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.pdf.modelId,
    });
    expect(resolveOrgAIModelForTask(config, "chat")?.provider).toBe("mistral");
  });
});
