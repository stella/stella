import { describe, expect, test } from "bun:test";

import {
  createDefaultRoleModels,
  createProviderCredentialDraft,
  decodeModelSelection,
  encodeModelSelection,
  ensureRoleModelsForProviders,
  getAvailableModelOptions,
  getNextAvailableProvider,
  getProviderValues,
  getRolePickerRows,
  hasUsableProviderDrafts,
  isKnownModelSelection,
  providerDraftsFromStoredProviders,
  roleModelsFromOverrideModels,
  serializeOverrideModels,
} from "@/components/ai-config-role-models.logic";
import type { RoleModelSelections } from "@/components/ai-config-role-models.logic";

describe("BYOK provider and model configuration", () => {
  test("creates role defaults from the first configured provider", () => {
    expect(createDefaultRoleModels(["anthropic", "openai"])).toEqual({
      chat: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      fast: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
      reasoning: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      pdf: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    });
  });

  test("normalizes stored providers for editing without exposing keys", () => {
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
        region: "global",
        replacingKey: false,
      },
    ]);
  });

  test("normalizes stored Azure Foundry provider endpoint metadata", () => {
    expect(
      providerDraftsFromStoredProviders([
        {
          provider: "azure_foundry",
          apiKeyMasked: "abcd****",
          endpoint: "https://example.openai.azure.com/openai",
          apiVersion: "2024-06-01",
        },
      ]),
    ).toEqual([
      {
        provider: "azure_foundry",
        apiKey: "",
        apiKeyMasked: "abcd****",
        endpoint: "https://example.openai.azure.com/openai",
        apiVersion: "2024-06-01",
        region: "global",
        replacingKey: false,
      },
    ]);
  });

  test("builds model options from the union of configured providers", () => {
    expect(
      getAvailableModelOptions([
        "anthropic",
        "mistral",
        "openai",
        "openrouter",
      ]),
    ).toContainEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      value: "anthropic::claude-opus-4-7",
    });
    expect(
      getAvailableModelOptions([
        "anthropic",
        "mistral",
        "openai",
        "openrouter",
      ]),
    ).toContainEqual({
      provider: "mistral",
      modelId: "mistral-large-latest",
      value: "mistral::mistral-large-latest",
    });
    expect(
      getAvailableModelOptions([
        "anthropic",
        "mistral",
        "openai",
        "openrouter",
      ]),
    ).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.4",
      value: "openai::gpt-5.4",
    });
    expect(
      getAvailableModelOptions([
        "anthropic",
        "mistral",
        "openai",
        "openrouter",
      ]),
    ).toContainEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.5-flash",
      value: "openrouter::google/gemini-3.5-flash",
    });
  });

  test("limits suggestions to current model families", () => {
    const modelOptions = getAvailableModelOptions([
      "anthropic",
      "google",
      "mistral",
      "openai",
    ]);

    expect(modelOptions).toContainEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      value: "anthropic::claude-opus-4-6",
    });
    expect(modelOptions).toContainEqual({
      provider: "google",
      modelId: "gemini-3.5-flash",
      value: "google::gemini-3.5-flash",
    });
    expect(modelOptions).toContainEqual({
      provider: "mistral",
      modelId: "magistral-medium-latest",
      value: "mistral::magistral-medium-latest",
    });
    expect(modelOptions).toContainEqual({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      value: "mistral::mistral-medium-3-5",
    });
    expect(modelOptions).toContainEqual({
      provider: "openai",
      modelId: "gpt-5.2",
      value: "openai::gpt-5.2",
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
      provider: "mistral",
      modelId: "mistral-tiny",
      value: "mistral::mistral-tiny",
    });
    expect(modelOptions).not.toContainEqual({
      provider: "mistral",
      modelId: "pixtral-large-latest",
      value: "mistral::pixtral-large-latest",
    });
    expect(modelOptions).not.toContainEqual({
      provider: "openai",
      modelId: "gpt-4o",
      value: "openai::gpt-4o",
    });
  });

  test("serializes every role as a provider-qualified model selection", () => {
    const roleModels: RoleModelSelections = {
      ...createDefaultRoleModels(["anthropic"]),
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    };

    expect(
      serializeOverrideModels({
        providers: ["anthropic", "openai"],
        roleModels,
      }),
    ).toEqual({
      chat: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      pdf: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    });
  });

  test("blocks serialization when a role is missing a model", () => {
    expect(
      serializeOverrideModels({
        providers: ["openai"],
        roleModels: {
          ...createDefaultRoleModels(["openai"]),
          pdf: null,
        },
      }),
    ).toBeNull();
  });

  test("allows configured providers that are not assigned to a role", () => {
    expect(
      serializeOverrideModels({
        providers: ["openai", "anthropic"],
        roleModels: createDefaultRoleModels(["openai"]),
      }),
    ).toEqual({
      chat: { provider: "openai", modelId: "gpt-5.4-mini" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "openai", modelId: "gpt-5.4" },
      pdf: { provider: "openai", modelId: "gpt-5.4" },
    });
  });

  test("keeps selected models only while their provider remains configured", () => {
    expect(
      ensureRoleModelsForProviders({
        providers: ["openai"],
        roleModels: {
          ...createDefaultRoleModels(["anthropic"]),
          fast: { provider: "openai", modelId: "gpt-5.4-nano" },
        },
      }),
    ).toEqual({
      chat: { provider: "openai", modelId: "gpt-5.4-mini" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "openai", modelId: "gpt-5.4" },
      pdf: { provider: "openai", modelId: "gpt-5.4" },
    });
  });

  test("normalizes stored role selections into picker state", () => {
    expect(
      roleModelsFromOverrideModels({
        providers: ["anthropic", "openai"],
        overrideModels: {
          chat: { provider: "anthropic", modelId: "claude-opus-4-5" },
          fast: { provider: "openai", modelId: "gpt-5.4-nano" },
        },
      }),
    ).toEqual({
      chat: { provider: "anthropic", modelId: "claude-opus-4-5" },
      fast: { provider: "openai", modelId: "gpt-5.4-nano" },
      reasoning: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      pdf: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    });
  });

  test("encodes OpenRouter model values without breaking model IDs that contain slashes", () => {
    const selection = {
      provider: "openrouter" as const,
      modelId: "anthropic/claude-opus-4.5",
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
          apiKey: "sk-or-v1-test",
        },
      ]),
    ).toBe(true);
  });

  test("requires an endpoint for Azure Foundry drafts", () => {
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("azure_foundry"),
          apiKey: "azure-test",
        },
      ]),
    ).toBe(false);
    expect(
      hasUsableProviderDrafts([
        {
          ...createProviderCredentialDraft("azure_foundry"),
          apiKey: "azure-test",
          endpoint: "https://example.openai.azure.com/openai/v1",
        },
      ]),
    ).toBe(true);
  });

  test("creates Mistral role defaults", () => {
    expect(createDefaultRoleModels(["mistral"])).toEqual({
      chat: { provider: "mistral", modelId: "mistral-large-latest" },
      fast: { provider: "mistral", modelId: "mistral-small-latest" },
      reasoning: { provider: "mistral", modelId: "magistral-medium-latest" },
      pdf: { provider: "mistral", modelId: "mistral-large-latest" },
    });
  });

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

  test("blocks model IDs outside Stella's offered list", () => {
    expect(
      isKnownModelSelection({
        provider: "openrouter",
        modelId: "anthropic/claude-opus-4.5",
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
          ...createDefaultRoleModels(["openrouter"]),
          chat: { provider: "openrouter", modelId: "x-ai/grok-4" },
        },
      }),
    ).toBeNull();
  });

  test("allows custom Azure Foundry deployment names", () => {
    expect(
      isKnownModelSelection({
        provider: "azure_foundry",
        modelId: "customer-deployment",
      }),
    ).toBe(true);
    expect(
      serializeOverrideModels({
        providers: ["azure_foundry"],
        roleModels: {
          chat: { provider: "azure_foundry", modelId: " customer-chat " },
          fast: { provider: "azure_foundry", modelId: "customer-fast" },
          reasoning: {
            provider: "azure_foundry",
            modelId: "customer-reasoning",
          },
          pdf: { provider: "azure_foundry", modelId: "customer-pdf" },
        },
      }),
    ).toEqual({
      chat: { provider: "azure_foundry", modelId: "customer-chat" },
      fast: { provider: "azure_foundry", modelId: "customer-fast" },
      reasoning: {
        provider: "azure_foundry",
        modelId: "customer-reasoning",
      },
      pdf: { provider: "azure_foundry", modelId: "customer-pdf" },
    });
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
        ...createDefaultRoleModels(["anthropic"]),
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
      modelId: "claude-sonnet-4-6",
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
});
