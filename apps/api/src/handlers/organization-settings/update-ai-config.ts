import { panic, Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import {
  decryptAIConfig,
  encryptAIConfig,
  maskApiKey,
} from "@/api/lib/ai-config-crypto";
import {
  isAllowedBYOKModel,
  MODEL_ROLES,
  supportsRegion,
} from "@/api/lib/ai-models";
import type {
  AIProvider,
  DataRegion,
  ModelRole,
  OrgAIConfig,
  OrgAIModelSelection,
  OrgAIProviderConfig,
} from "@/api/lib/ai-models";
import { probeProvider } from "@/api/lib/ai-provider-probe";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { normalizeAzureFoundryBaseURL } from "@/api/lib/azure-foundry";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const BYOK_PROVIDER_VALUES = [
  "google",
  "openrouter",
  "openai",
  "azure_foundry",
  "anthropic",
  "mistral",
] as const satisfies readonly AIProvider[];
type BYOKProvider = (typeof BYOK_PROVIDER_VALUES)[number];

const providerBody = t.Object({
  provider: t.UnionEnum(BYOK_PROVIDER_VALUES),
  apiKey: t.Optional(t.String({ minLength: 1 })),
  endpoint: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
  apiVersion: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
});

const modelSelectionBody = t.Object({
  provider: t.UnionEnum(BYOK_PROVIDER_VALUES),
  modelId: t.String({ minLength: 1, maxLength: 256 }),
});

const updateAIConfigBody = t.Object({
  providers: t.Array(providerBody, { minItems: 1 }),
  overrideModels: t.Object({
    fast: modelSelectionBody,
    chat: modelSelectionBody,
    reasoning: modelSelectionBody,
    pdf: modelSelectionBody,
  }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateAIConfigBody,
} satisfies HandlerConfig;

/**
 * Update the org's AI config (BYOK).
 *
 * Validates the API key with a lightweight test call,
 * encrypts the config, and stores it.
 */
const updateAIConfig = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body }) {
    let existingConfig: OrgAIConfig | undefined;
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: {
              eq: session.activeOrganizationId,
            },
          },
          columns: {
            aiConfigEncrypted: true,
            aiConfigIv: true,
          },
        }),
      ),
    );

    const ciphertext = row?.aiConfigEncrypted;
    const iv = row?.aiConfigIv;
    if (ciphertext && iv) {
      const decryptResult = await Result.tryPromise({
        try: async () =>
          await decryptAIConfig(session.activeOrganizationId, ciphertext, iv),
        catch: (error: unknown) => error,
      });

      if (decryptResult.isErr()) {
        captureError(decryptResult.error);
        existingConfig = undefined;
      } else {
        existingConfig = decryptResult.value;
      }
    }

    const providerResult = resolveProviderConfigs(
      body.providers,
      existingConfig,
    );
    if (!providerResult.valid) {
      return Result.err(
        new HandlerError({ status: 400, message: providerResult.error }),
      );
    }

    const modelResult = normalizeOverrideModels(
      body.overrideModels,
      providerResult.providers,
    );
    if (!modelResult.valid) {
      return Result.err(
        new HandlerError({ status: 400, message: modelResult.error }),
      );
    }

    const newKeyProviders = new Set(
      body.providers
        .filter((provider) => provider.apiKey)
        .map((provider) => provider.provider),
    );

    const providersToValidate = providerResult.providers.filter(
      (providerConfig) =>
        shouldValidateProviderConfig({
          existingConfig,
          newKeyProviders,
          overrideModels: modelResult.overrideModels,
          providerConfig,
        }),
    );

    const validationResults = await Promise.all(
      providersToValidate.map(
        async (providerConfig) =>
          await validateProviderKey(providerConfig, modelResult.overrideModels),
      ),
    );

    const failures = validationResults.flatMap((result, index) => {
      if (result.valid) {
        return [];
      }
      const providerConfig =
        providersToValidate[index] ??
        panic("validation result index out of range");
      return [`${providerConfig.provider}: ${result.error}`];
    });

    if (failures.length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: failures.join("; "),
        }),
      );
    }

    const orgConfig: OrgAIConfig = {
      providers: providerResult.providers,
      overrideModels: modelResult.overrideModels,
    };

    const { ciphertext: newCiphertext, iv: newIv } = await encryptAIConfig(
      session.activeOrganizationId,
      orgConfig,
    );

    yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            aiConfigEncrypted: newCiphertext,
            aiConfigIv: newIv,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              aiConfigEncrypted: newCiphertext,
              aiConfigIv: newIv,
              updatedAt: new Date(),
            },
          }),
      ),
    );

    return Result.ok({
      providers: orgConfig.providers.map((providerConfig) => ({
        provider: providerConfig.provider,
        apiKeyMasked: maskApiKey(providerConfig.apiKey),
        region:
          providerConfig.provider === "azure_foundry"
            ? "global"
            : (providerConfig.region ?? "global"),
        ...(providerConfig.provider === "azure_foundry"
          ? {
              endpoint: providerConfig.baseURL,
              apiVersion: providerConfig.apiVersion,
            }
          : {}),
      })),
      overrideModels: orgConfig.overrideModels,
    });
  },
);

type ValidationResult = { valid: true } | { valid: false; error: string };

type ProviderConfigInput = {
  provider: BYOKProvider;
  apiKey?: string | undefined;
  endpoint?: string | undefined;
  apiVersion?: string | undefined;
  region?: DataRegion | undefined;
};

type ProviderConfigResult =
  | {
      valid: true;
      providers: (OrgAIProviderConfig & { provider: BYOKProvider })[];
    }
  | { valid: false; error: string };

const resolveProviderConfigs = (
  providers: readonly ProviderConfigInput[],
  existingConfig: OrgAIConfig | undefined,
): ProviderConfigResult => {
  const resolvedProviders: (OrgAIProviderConfig & {
    provider: BYOKProvider;
  })[] = [];
  const seenProviders = new Set<AIProvider>();

  for (const providerInput of providers) {
    if (seenProviders.has(providerInput.provider)) {
      return {
        valid: false,
        error: `Provider ${providerInput.provider} is configured more than once`,
      };
    }
    seenProviders.add(providerInput.provider);

    const existingProvider = existingConfig?.providers.find(
      (candidate) => candidate.provider === providerInput.provider,
    );
    const apiKey = providerInput.apiKey?.trim() || existingProvider?.apiKey;

    if (!apiKey) {
      return {
        valid: false,
        error: `API key is required for ${providerInput.provider}`,
      };
    }

    if (providerInput.provider === "azure_foundry") {
      const existingEndpoint =
        existingProvider?.provider === "azure_foundry"
          ? existingProvider.baseURL
          : undefined;
      const endpoint = providerInput.endpoint?.trim() || existingEndpoint;
      if (!endpoint) {
        return {
          valid: false,
          error: "Endpoint is required for azure_foundry",
        };
      }

      const normalized = normalizeAzureFoundryBaseURL(endpoint);
      if (!normalized.ok) {
        return { valid: false, error: normalized.error };
      }

      const existingApiVersion =
        existingProvider?.provider === "azure_foundry"
          ? existingProvider.apiVersion
          : undefined;
      const apiVersion = providerInput.apiVersion?.trim() || existingApiVersion;

      resolvedProviders.push({
        provider: providerInput.provider,
        apiKey,
        baseURL: normalized.baseURL,
        ...(apiVersion ? { apiVersion } : {}),
      });
      continue;
    }

    if (
      providerInput.region &&
      providerInput.region !== "global" &&
      !supportsRegion(providerInput.provider)
    ) {
      return {
        valid: false,
        error:
          `Regional routing is not supported for ${providerInput.provider}. ` +
          "Only Google AI supports EU/CH regional endpoints via Vertex AI.",
      };
    }

    resolvedProviders.push({
      provider: providerInput.provider,
      apiKey,
      region: supportsRegion(providerInput.provider)
        ? (providerInput.region ??
          (existingProvider?.provider === "azure_foundry"
            ? undefined
            : existingProvider?.region) ??
          "global")
        : "global",
    });
  }

  return { valid: true, providers: resolvedProviders };
};

type OverrideModelsInput = Record<ModelRole, OrgAIModelSelection>;

type OverrideModelsResult =
  | { valid: true; overrideModels: Record<ModelRole, OrgAIModelSelection> }
  | { valid: false; error: string };

const normalizeRoleSelection = (
  role: ModelRole,
  overrideModels: OverrideModelsInput,
  configuredProviders: ReadonlySet<AIProvider>,
):
  | { valid: true; selection: OrgAIModelSelection }
  | { valid: false; error: string } => {
  const selection = overrideModels[role];
  const modelId = selection.modelId.trim();

  if (!modelId) {
    return { valid: false, error: `Model selection is required for ${role}` };
  }

  if (!configuredProviders.has(selection.provider)) {
    return {
      valid: false,
      error: `Model selection for ${role} uses an unconfigured provider`,
    };
  }

  if (!isAllowedBYOKModel(selection.provider, modelId)) {
    return {
      valid: false,
      error: `Model "${modelId}" is not offered for ${selection.provider}`,
    };
  }

  return {
    valid: true,
    selection: { provider: selection.provider, modelId },
  };
};

const normalizeOverrideModels = (
  overrideModels: OverrideModelsInput,
  providers: readonly OrgAIProviderConfig[],
): OverrideModelsResult => {
  const configuredProviders = new Set(
    providers.map((providerConfig) => providerConfig.provider),
  );

  const chat = normalizeRoleSelection(
    "chat",
    overrideModels,
    configuredProviders,
  );
  if (!chat.valid) {
    return chat;
  }
  const fast = normalizeRoleSelection(
    "fast",
    overrideModels,
    configuredProviders,
  );
  if (!fast.valid) {
    return fast;
  }
  const reasoning = normalizeRoleSelection(
    "reasoning",
    overrideModels,
    configuredProviders,
  );
  if (!reasoning.valid) {
    return reasoning;
  }
  const pdf = normalizeRoleSelection(
    "pdf",
    overrideModels,
    configuredProviders,
  );
  if (!pdf.valid) {
    return pdf;
  }

  const referencedProviders = new Set<AIProvider>([
    chat.selection.provider,
    fast.selection.provider,
    reasoning.selection.provider,
    pdf.selection.provider,
  ]);

  for (const provider of configuredProviders) {
    if (!referencedProviders.has(provider)) {
      return {
        valid: false,
        error: `Provider ${provider} is configured but not used by any role`,
      };
    }
  }

  return {
    valid: true,
    overrideModels: {
      chat: chat.selection,
      fast: fast.selection,
      reasoning: reasoning.selection,
      pdf: pdf.selection,
    },
  };
};

type ShouldValidateProviderConfigOptions = {
  existingConfig: OrgAIConfig | undefined;
  newKeyProviders: ReadonlySet<AIProvider>;
  overrideModels: Record<ModelRole, OrgAIModelSelection>;
  providerConfig: OrgAIProviderConfig;
};

const shouldValidateProviderConfig = ({
  existingConfig,
  newKeyProviders,
  overrideModels,
  providerConfig,
}: ShouldValidateProviderConfigOptions): boolean => {
  if (newKeyProviders.has(providerConfig.provider)) {
    return true;
  }

  if (providerConfig.provider !== "azure_foundry") {
    return false;
  }

  const existingProvider = existingConfig?.providers.find(
    (candidate) => candidate.provider === providerConfig.provider,
  );
  if (existingProvider?.provider !== "azure_foundry") {
    return true;
  }

  if (
    providerConfig.baseURL !== existingProvider.baseURL ||
    providerConfig.apiVersion !== existingProvider.apiVersion
  ) {
    return true;
  }

  return MODEL_ROLES.some(
    (role) =>
      overrideModels[role].provider === "azure_foundry" &&
      existingConfig?.overrideModels[role]?.modelId !==
        overrideModels[role].modelId,
  );
};

// Settings save tolerates a slower upstream than onboarding's probe:
// a one-shot save shouldn't fail a healthy key because the provider
// took 6 s instead of 4 s to answer list-models. Onboarding uses the
// shorter default and soft-passes 502s at the frontend.
const SETTINGS_PROBE_TIMEOUT_MS = 20_000;

/**
 * Validate a provider API key via the shared lightweight probe
 * (provider's own auth/list-models endpoint). No token cost and
 * avoids per-model quirks like reasoning-model token minimums.
 * For Azure Foundry, also verifies each role's deployment name
 * exists, since those are free-text values typed by the user.
 */
const validateProviderKey = async (
  providerConfig: OrgAIProviderConfig & { provider: BYOKProvider },
  overrideModels: Record<ModelRole, OrgAIModelSelection>,
): Promise<ValidationResult> => {
  const result = await Result.tryPromise({
    try: async () =>
      await probeProvider(
        providerConfig.provider,
        providerConfig.apiKey,
        providerConfig.provider === "azure_foundry"
          ? providerConfig.baseURL
          : undefined,
        providerConfig.provider === "azure_foundry"
          ? providerConfig.apiVersion
          : undefined,
        providerConfig.provider === "azure_foundry"
          ? collectAzureDeployments(overrideModels)
          : undefined,
        SETTINGS_PROBE_TIMEOUT_MS,
      ),
    catch: (error: unknown) =>
      `API key validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  });

  if (result.isErr()) {
    return { valid: false, error: result.error };
  }
  if (!result.value.valid) {
    return { valid: false, error: result.value.error ?? "Unknown error" };
  }
  return { valid: true };
};

const collectAzureDeployments = (
  overrideModels: Record<ModelRole, OrgAIModelSelection>,
): readonly string[] =>
  Array.from(
    new Set(
      MODEL_ROLES.flatMap((role) =>
        overrideModels[role].provider === "azure_foundry"
          ? [overrideModels[role].modelId]
          : [],
      ),
    ),
  );

export default updateAIConfig;
