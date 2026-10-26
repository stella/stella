import { describe, expect, test } from "bun:test";

import { DECISION_MODEL_PROVIDERS } from "@stll/ai-catalog";

import {
  createDecisionModelState,
  createProviderCredentialDraft,
  DECISION_PROVIDER_KEYS,
  decisionModelDraft,
  decodeModelSelection,
  encodeModelSelection,
  getAvailableModelOptions,
  getModelOptionsForRole,
  getNextAvailableProvider,
  getProviderValues,
  getRolePickerRows,
  hasProviderCredentialChanges,
  hasUsableDecisionModel,
  hasUsableProviderDrafts,
  haveSameRoleModelSelections,
  isKnownModelSelection,
  isKnownModelSelectionForRole,
  isProviderRoleSupported,
  projectDefaultRoleModels,
  projectProviderDefaultRoleModels,
  PROVIDER_KEYS,
  providerDraftsFromStoredProviders,
  ROLE_KEYS,
  roleModelsFromOverrideModels,
  roleOverridesFromStoredModels,
  serializeDecisionModel,
  serializeOverrideModels,
  serializeProviderDrafts,
  serializeRoleOverrides,
} from "@/components/ai-config-role-models.logic";
import type {
  RoleModelSelections,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";

const GOOGLE_DEFAULTS = {
  chat: { provider: "google", modelId: "gemini-3.8-flash" },
  fast: { provider: "google", modelId: "gemini-3.8-flash" },
  reasoning: { provider: "google", modelId: "gemini-3.8-flash" },
  pdf: { provider: "google", modelId: "gemini-3.8-flash" },
} satisfies RoleModelSelections;
const ANTHROPIC_DEFAULTS = {
  chat: { provider: "anthropic", modelId: "claude-opus-5-5" },
  fast: { provider: "anthropic", modelId: "claude-haiku-5-5" },
  reasoning: { provider: "anthropic", modelId: "claude-opus-5-5" },
  pdf: { provider: "anthropic", modelId: "claude-opus-5-5" },
} satisfies RoleModelSelections;
const OPENAI_DEFAULTS = {
  chat: { provider: "openai", modelId: "gpt-6-sol" },
  fast: { provider: "openai", modelId: "gpt-6-luna" },
  reasoning: { provider: "openai", modelId: "gpt-6-sol" },
  pdf: { provider: "openai", modelId: "gpt-6-sol" },
} satisfies RoleModelSelections;
const OPENROUTER_DEFAULTS = {
  chat: { provider: "openrouter", modelId: "openai/gpt-6-sol" },
  fast: { provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" },
  reasoning: { provider: "openrouter", modelId: "openai/gpt-6-sol" },
  pdf: { provider: "openrouter", modelId: "openai/gpt-6-sol" },
} satisfies RoleModelSelections;
const MISTRAL_DEFAULTS = {
  chat: { provider: "mistral", modelId: "mistral-medium-latest" },
  fast: { provider: "mistral", modelId: "mistral-small-latest" },
  reasoning: { provider: "mistral", modelId: "mistral-medium-latest" },
  pdf: null,
} satisfies RoleModelSelections;

describe("BYOK provider and model configuration", () => {
  test("preserves stored provider settings for editing without exposing keys", () => {
    expect(
      providerDraftsFromStoredProviders([
        {
          provider: "google",
          apiKeyMasked: "AIza****",
          region: "eu",
        },
        {
          provider: "openai",
          apiKeyMasked: "sk-proj****",
          region: "eu",
        },
      ]),
    ).toEqual([
      {
        provider: "google",
        apiKey: "",
        apiKeyMasked: "AIza****",
        endpoint: "",
        region: "eu",
        replacingKey: false,
      },
      {
        provider: "openai",
        apiKey: "",
        apiKeyMasked: "sk-proj****",
        endpoint: "",
        region: "eu",
        replacingKey: false,
      },
    ]);
  });

  test("ignores stored providers that are not supported by TanStack AI", () => {
    expect(
      providerDraftsFromStoredProviders([
        {
          provider: "azure_foundry",
          apiKeyMasked: "abcd****",
          endpoint: "https://example.openai.azure.com/openai",
          apiVersion: "2024-06-01",
        },
      ]),
    ).toEqual([createProviderCredentialDraft()]);
  });

  test("builds model options from the union of configured providers", () => {
    expect(
      getAvailableModelOptions(["anthropic", "openai", "openrouter"]),
    ).toContainEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      value: "anthropic::claude-sonnet-5",
    });
    expect(
      getAvailableModelOptions(["anthropic", "openai", "openrouter"]),
    ).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.6",
      value: "openai::gpt-5.6",
    });
    expect(
      getAvailableModelOptions(["anthropic", "openai", "openrouter"]),
    ).toContainEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.6-flash",
      value: "openrouter::google/gemini-3.6-flash",
    });
  });

  test("limits suggestions to current model families", () => {
    const modelOptions = getAvailableModelOptions([
      "anthropic",
      "google",
      "openai",
    ]);

    expect(modelOptions).toContainEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      value: "anthropic::claude-sonnet-5",
    });
    expect(modelOptions).toContainEqual({
      provider: "google",
      modelId: "gemini-3.7-flash",
      value: "google::gemini-3.7-flash",
    });
    expect(modelOptions).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.6",
      value: "openai::gpt-5.6",
    });
    expect(modelOptions).not.toContainEqual({
      provider: "anthropic",
      modelId: "claude-2",
      value: "anthropic::claude-2",
    });
    expect(modelOptions).not.toContainEqual({
      provider: "google",
      modelId: "gemini-2.5-pro",
      value: "google::gemini-2.5-pro",
    });
    expect(modelOptions).not.toContainEqual({
      provider: "openai",
      modelId: "gpt-4o",
      value: "openai::gpt-4o",
    });
  });

  test("serializes every role as a provider-qualified model selection", () => {
    const roleModels: RoleModelSelections = {
      ...ANTHROPIC_DEFAULTS,
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    };

    expect(
      serializeOverrideModels({
        providers: ["anthropic", "openai"],
        roleModels,
      }),
    ).toEqual({
      chat: { provider: "anthropic", modelId: "claude-opus-5-5" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "anthropic", modelId: "claude-opus-5-5" },
      pdf: { provider: "anthropic", modelId: "claude-opus-5-5" },
    });
  });

  test("blocks Mistral PDF selections", () => {
    const roleModels: RoleModelSelections = {
      ...MISTRAL_DEFAULTS,
      pdf: { provider: "mistral", modelId: "mistral-large-latest" },
    };

    expect(isProviderRoleSupported("mistral", "chat")).toBe(true);
    expect(isProviderRoleSupported("mistral", "pdf")).toBe(false);
    expect(
      getModelOptionsForRole({ provider: "mistral", role: "pdf" }),
    ).toEqual([]);
    expect(
      isKnownModelSelectionForRole({
        role: "pdf",
        selection: { provider: "mistral", modelId: "mistral-large-latest" },
      }),
    ).toBe(false);
    expect(
      serializeOverrideModels({
        providers: ["mistral"],
        roleModels,
      }),
    ).toBeNull();
  });

  test("blocks serialization when a role is missing a model", () => {
    expect(
      serializeOverrideModels({
        providers: ["openai"],
        roleModels: {
          ...OPENAI_DEFAULTS,
          pdf: null,
        },
      }),
    ).toBeNull();
  });

  test("allows configured providers that are not assigned to a role", () => {
    expect(
      serializeOverrideModels({
        providers: ["openai", "anthropic"],
        roleModels: OPENAI_DEFAULTS,
      }),
    ).toEqual({
      chat: { provider: "openai", modelId: "gpt-6-sol" },
      fast: { provider: "openai", modelId: "gpt-6-luna" },
      reasoning: { provider: "openai", modelId: "gpt-6-sol" },
      pdf: { provider: "openai", modelId: "gpt-6-sol" },
    });
  });

  test("uses server defaults independently of provider order and preserves explicit selections", () => {
    expect(
      roleModelsFromOverrideModels({
        providers: ["anthropic", "google"],
        defaultModels: GOOGLE_DEFAULTS,
        overrideModels: {
          fast: { provider: "anthropic", modelId: "claude-opus-5-5" },
        },
      }),
    ).toEqual({
      ...GOOGLE_DEFAULTS,
      fast: { provider: "anthropic", modelId: "claude-opus-5-5" },
    });
    expect(GOOGLE_DEFAULTS.fast.provider).toBe("google");
  });

  test("projects custom API providers as unavailable in the settings picker", () => {
    expect(
      projectDefaultRoleModels({
        ...GOOGLE_DEFAULTS,
        fast: { provider: "huggingface", modelId: "fixture-custom-model" },
      }),
    ).toEqual({ ...GOOGLE_DEFAULTS, fast: null });
    expect(
      projectProviderDefaultRoleModels([
        {
          provider: "huggingface",
          defaultModels: {
            ...GOOGLE_DEFAULTS,
            fast: { provider: "huggingface", modelId: "fixture-custom-model" },
          },
        },
        { provider: "google", defaultModels: GOOGLE_DEFAULTS },
      ]),
    ).toEqual([{ provider: "google", defaultModels: GOOGLE_DEFAULTS }]);
  });

  test("normalizes stored role selections into picker state", () => {
    expect(
      roleModelsFromOverrideModels({
        providers: ["anthropic", "openai"],
        defaultModels: ANTHROPIC_DEFAULTS,
        overrideModels: {
          chat: { provider: "anthropic", modelId: "claude-opus-4-5" },
          fast: { provider: "openai", modelId: "gpt-5.4-nano" },
        },
      }),
    ).toEqual({
      chat: { provider: "anthropic", modelId: "claude-opus-4-5" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "anthropic", modelId: "claude-opus-5-5" },
      pdf: { provider: "anthropic", modelId: "claude-opus-5-5" },
    });
  });

  test("encodes OpenRouter model values without breaking model IDs that contain slashes", () => {
    const selection = {
      provider: "openrouter" as const,
      modelId: "anthropic/claude-opus-4.8",
    };

    expect(decodeModelSelection(encodeModelSelection(selection))).toEqual(
      selection,
    );
  });

  test("validates provider drafts before enabling save", () => {
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("openrouter"),
        },
      ]),
    ).toBe(false);
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("openrouter"),
          apiKey: "test-openrouter-provider-key",
        },
      ]),
    ).toBe(true);
  });

  test("serializes TanStack provider drafts for save payloads", () => {
    expect(
      serializeProviderDrafts([
        {
          ...createProviderCredentialDraft("openai"),
          apiKeyMasked: "sk-proj****",
          replacingKey: false,
        },
      ]),
    ).toEqual([
      {
        provider: "openai",
        region: "global",
      },
    ]);
  });

  test("serializes trimmed Anthropic credentials and workspace IDs", () => {
    expect(
      serializeProviderDrafts([
        {
          ...createProviderCredentialDraft("anthropic"),
          apiKey: "  sk-ant-api03-fixture  ",
          anthropicWorkspaceId: "  wrkspc_fixture  ",
        },
      ]),
    ).toEqual([
      {
        provider: "anthropic",
        apiKey: "sk-ant-api03-fixture",
        anthropicWorkspaceId: "wrkspc_fixture",
        region: "global",
      },
    ]);
  });

  test("an empty workspace ID explicitly clears Anthropic workspace scope while keeping the saved key", () => {
    expect(
      serializeProviderDrafts([
        {
          ...createProviderCredentialDraft("anthropic"),
          apiKey: "  ",
          apiKeyMasked: "sk-ant-api03****1234",
          replacingKey: false,
          anthropicWorkspaceId: "  ",
        },
      ]),
    ).toEqual([
      {
        provider: "anthropic",
        anthropicWorkspaceId: "",
        region: "global",
      },
    ]);
  });

  test.each(PROVIDER_KEYS)(
    "workspace scope serialization is provider-specific for %s",
    (provider) => {
      expect(
        serializeProviderDrafts([
          {
            ...createProviderCredentialDraft(provider),
            anthropicWorkspaceId: "  wrkspc_fixture  ",
          },
        ]),
      ).toEqual([
        {
          provider,
          ...(provider === "anthropic"
            ? { anthropicWorkspaceId: "wrkspc_fixture" }
            : {}),
          region: "global",
        },
      ]);
      expect(
        serializeProviderDrafts([
          {
            ...createProviderCredentialDraft(provider),
            anthropicWorkspaceId: "  ",
          },
        ]),
      ).toEqual([
        {
          provider,
          ...(provider === "anthropic" ? { anthropicWorkspaceId: "" } : {}),
          region: "global",
        },
      ]);
      expect(
        serializeProviderDrafts([createProviderCredentialDraft(provider)]),
      ).toEqual([
        {
          provider,
          region: "global",
        },
      ]);
    },
  );

  test("accepts saved provider drafts without requiring key replacement", () => {
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("openai"),
          apiKeyMasked: "sk-proj****",
          replacingKey: false,
        },
      ]),
    ).toBe(true);
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("openai"),
          apiKeyMasked: "sk-proj****",
          replacingKey: true,
        },
      ]),
    ).toBe(false);
  });

  test("blocks model IDs outside stella's offered list", () => {
    expect(
      isKnownModelSelection({
        provider: "openrouter",
        modelId: "anthropic/claude-opus-4.8",
      }),
    ).toBe(true);
    expect(
      isKnownModelSelection({
        provider: "openrouter",
        modelId: "x-ai/grok-4",
      }),
    ).toBe(false);
    expect(
      serializeOverrideModels({
        providers: ["openrouter"],
        roleModels: {
          ...OPENROUTER_DEFAULTS,
          chat: { provider: "openrouter", modelId: "x-ai/grok-4" },
        },
      }),
    ).toBeNull();
  });

  test("finds provider values and the next addable provider", () => {
    const providers = [createProviderCredentialDraft("google")];

    expect(getProviderValues(providers)).toEqual(["google"]);
    expect(getNextAvailableProvider(providers)).toBe("anthropic");
  });

  test("builds stable rows for the role/model picker", () => {
    const rows = getRolePickerRows({
      providers: ["anthropic", "openai"],
      roleModels: {
        ...ANTHROPIC_DEFAULTS,
        fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      },
    });

    expect(rows.map((row) => row.role)).toEqual([
      "chat",
      "fast",
      "reasoning",
      "pdf",
    ]);
    expect(rows.at(0)?.selection).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(rows.at(1)?.value).toBe("openai::gpt-5.4-nano");
    expect(rows.at(0)?.modelOptions).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.2",
      value: "openai::gpt-5.2",
    });
    expect(rows.at(0)?.modelOptions).toContainEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      value: "anthropic::claude-opus-4-6",
    });
  });

  test("builds role-specific picker rows", () => {
    const rows = getRolePickerRows({
      providers: ["mistral", "openai"],
      roleModels: { ...MISTRAL_DEFAULTS, pdf: OPENAI_DEFAULTS.pdf },
    });

    const chatRow = rows.find((row) => row.role === "chat");
    const pdfRow = rows.find((row) => row.role === "pdf");

    expect(chatRow?.modelOptions).toContainEqual({
      provider: "mistral",
      modelId: "mistral-large-latest",
      value: "mistral::mistral-large-latest",
    });
    expect(pdfRow?.selection).toEqual({
      provider: "openai",
      modelId: "gpt-6-sol",
    });
    expect(pdfRow?.modelOptions).not.toContainEqual({
      provider: "mistral",
      modelId: "mistral-large-latest",
      value: "mistral::mistral-large-latest",
    });
  });
});

describe("decision model configuration", () => {
  const stored: StoredDecisionModel = {
    provider: "typesafe",
    apiKeyMasked: "ts-live****",
    modelId: "jev-latest",
  };

  test("omits the field while the section is untouched, so the stored model survives a save", () => {
    expect(serializeDecisionModel({ kind: "untouched" })).toBeUndefined();
  });

  test("sends null once the model is removed", () => {
    expect(serializeDecisionModel({ kind: "cleared" })).toBeNull();
  });

  test("sends the typed key, and omits it when the input is left empty", () => {
    expect(
      serializeDecisionModel({
        kind: "set",
        provider: "typesafe",
        apiKey: "  ts-new-decision-key  ",
        modelId: "  jev-latest  ",
      }),
    ).toEqual({
      provider: "typesafe",
      apiKey: "ts-new-decision-key",
      modelId: "jev-latest",
    });

    expect(
      serializeDecisionModel({
        kind: "set",
        provider: "typesafe",
        apiKey: "   ",
        modelId: "jev-latest",
      }),
    ).toEqual({ provider: "typesafe", modelId: "jev-latest" });
  });

  test("enables a new model on the default provider and model id", () => {
    expect(createDecisionModelState()).toEqual({
      kind: "set",
      provider: "typesafe",
      apiKey: "",
      modelId: "jev-latest",
    });
  });

  test("renders the stored model until the section is edited or cleared", () => {
    expect(
      decisionModelDraft({ state: { kind: "untouched" }, stored }),
    ).toEqual({
      provider: "typesafe",
      apiKey: "",
      apiKeyMasked: "ts-live****",
      modelId: "jev-latest",
    });
    expect(
      decisionModelDraft({ state: { kind: "untouched" }, stored: null }),
    ).toBeNull();
    expect(
      decisionModelDraft({ state: { kind: "cleared" }, stored }),
    ).toBeNull();
  });

  test("offers the stored key as reusable only for the provider it was issued for", () => {
    expect(
      decisionModelDraft({
        state: {
          kind: "set",
          provider: "typesafe",
          apiKey: "",
          modelId: "jev-2026-01",
        },
        stored,
      }),
    ).toEqual({
      provider: "typesafe",
      apiKey: "",
      apiKeyMasked: "ts-live****",
      modelId: "jev-2026-01",
    });
    expect(
      decisionModelDraft({
        state: {
          kind: "set",
          provider: "typesafe",
          apiKey: "",
          modelId: "jev-latest",
        },
        stored: null,
      }),
    ).toEqual({ provider: "typesafe", apiKey: "", modelId: "jev-latest" });
  });

  test("blocks a save that would send a decision model with no key or no model", () => {
    expect(
      hasUsableDecisionModel({ state: { kind: "untouched" }, stored }),
    ).toBe(true);
    expect(hasUsableDecisionModel({ state: { kind: "cleared" }, stored })).toBe(
      true,
    );
    expect(
      hasUsableDecisionModel({ state: createDecisionModelState(), stored }),
    ).toBe(true);
    expect(
      hasUsableDecisionModel({
        state: createDecisionModelState(),
        stored: null,
      }),
    ).toBe(false);
    expect(
      hasUsableDecisionModel({
        state: {
          kind: "set",
          provider: "typesafe",
          apiKey: "ts-new-decision-key",
          modelId: "   ",
        },
        stored,
      }),
    ).toBe(false);
  });
});

describe("OpenAI decision settings", () => {
  test("offers every decision provider the API accepts", () => {
    expect(DECISION_PROVIDER_KEYS).toEqual(DECISION_MODEL_PROVIDERS);
  });
  test("provider switch resets to the provider's default model and reused OpenAI key", () => {
    const state = createDecisionModelState("openai");
    expect(state).toEqual({
      kind: "set",
      provider: "openai",
      apiKey: "",
      modelId: "gpt-6-luna",
      region: "eu",
      keyMode: "reuse",
    });
    expect(serializeDecisionModel(state)).toEqual({
      provider: "openai",
      apiKey: null,
      modelId: "gpt-6-luna",
      region: "eu",
    });
    expect(
      hasUsableDecisionModel({ state, stored: null, hasOpenAIKey: true }),
    ).toBe(true);
    expect(
      hasUsableDecisionModel({ state, stored: null, hasOpenAIKey: false }),
    ).toBe(false);
  });
  test("a separate override is required when no OpenAI key is configured", () => {
    expect(createDecisionModelState("openai", false)).toEqual({
      kind: "set",
      provider: "openai",
      apiKey: "",
      modelId: "gpt-6-luna",
      region: "eu",
      keyMode: "override",
    });
    expect(
      serializeDecisionModel({
        kind: "set",
        provider: "openai",
        apiKey: " override ",
        modelId: "gpt-6-luna",
        region: "global",
        keyMode: "override",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "override",
      modelId: "gpt-6-luna",
      region: "global",
    });
  });
  test("read-back keeps key mode and region without borrowing another provider's key", () => {
    const stored = {
      provider: "openai",
      modelId: "gpt-6-luna",
      region: "global",
      apiKeyMasked: undefined,
    } as const satisfies StoredDecisionModel;
    expect(
      decisionModelDraft({ state: { kind: "untouched" }, stored }),
    ).toEqual({
      provider: "openai",
      apiKey: "",
      apiKeyMasked: undefined,
      modelId: "gpt-6-luna",
      region: "global",
      keyMode: "reuse",
    });
    const state = createDecisionModelState("openai", false);
    expect(hasUsableDecisionModel({ state, stored, hasOpenAIKey: true })).toBe(
      false,
    );
  });
});
describe("provider credential changes", () => {
  test.each([
    { draftId: undefined, storedId: undefined, changed: false },
    { draftId: "", storedId: undefined, changed: false },
    { draftId: "  ", storedId: undefined, changed: false },
    { draftId: undefined, storedId: "  ", changed: false },
    { draftId: " wrkspc_fixture ", storedId: "wrkspc_fixture", changed: false },
    { draftId: "", storedId: "wrkspc_fixture", changed: true },
    { draftId: "wrkspc_fixture", storedId: undefined, changed: true },
  ])(
    "normalizes workspace scope $draftId against $storedId",
    ({ draftId, storedId, changed }) => {
      expect(
        hasProviderCredentialChanges({
          draft: {
            ...createProviderCredentialDraft("anthropic"),
            anthropicWorkspaceId: draftId,
          },
          stored: {
            ...createProviderCredentialDraft("anthropic"),
            anthropicWorkspaceId: storedId,
          },
        }),
      ).toBe(changed);
    },
  );
  test("a key still needs saving when workspace scope is unchanged", () => {
    expect(
      hasProviderCredentialChanges({
        draft: {
          ...createProviderCredentialDraft("anthropic"),
          apiKey: "sk-ant-usr-fixture",
          anthropicWorkspaceId: "",
        },
        stored: undefined,
      }),
    ).toBe(true);
  });
});

test("only explicit role overrides are serialized, even when equal to a default", () => {
  const defaults = GOOGLE_DEFAULTS;
  const chat = defaults.chat;
  expect(
    serializeRoleOverrides({ providers: ["google"], overrides: {} }),
  ).toEqual({ kind: "valid", overrides: null });
  expect(
    serializeRoleOverrides({ providers: ["google"], overrides: { chat } }),
  ).toEqual({ kind: "valid", overrides: { chat } });
  expect(
    roleOverridesFromStoredModels({
      providers: ["google"],
      overrideModels: { chat },
    }),
  ).toEqual({ chat });
  expect(
    serializeRoleOverrides({
      providers: ["google"],
      overrides: { chat: null },
    }),
  ).toEqual({ kind: "invalid" });
});

test("role comparison ignores insertion order while preserving default and explicit selection states", () => {
  const baseline = GOOGLE_DEFAULTS;
  for (const [offset, role] of ROLE_KEYS.entries()) {
    const order = [
      ...ROLE_KEYS.slice(offset),
      ...ROLE_KEYS.slice(0, offset),
    ].toReversed();
    const current = Object.fromEntries(
      order.map((key) => [key, baseline[key]]),
    );
    expect(haveSameRoleModelSelections({ current, baseline })).toBe(true);
    expect(
      haveSameRoleModelSelections({
        current: { ...current, [role]: null },
        baseline,
      }),
    ).toBe(false);
    const selection = baseline[role];
    expect(
      haveSameRoleModelSelections({
        current: {
          ...current,
          [role]: { ...selection, modelId: `${selection.modelId}-different` },
        },
        baseline,
      }),
    ).toBe(false);
    expect(
      haveSameRoleModelSelections({
        current: {
          ...current,
          [role]: { ...selection, provider: "anthropic" },
        },
        baseline,
      }),
    ).toBe(false);
    expect(
      haveSameRoleModelSelections({
        current: { [role]: selection },
        baseline: {},
      }),
    ).toBe(false);
  }
  expect(haveSameRoleModelSelections({ current: {}, baseline: {} })).toBe(true);
  expect(
    haveSameRoleModelSelections({ current: {}, baseline: { chat: null } }),
  ).toBe(false);
});
