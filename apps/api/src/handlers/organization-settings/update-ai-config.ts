import { generateText } from "ai";
import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { invalidateOrgAIConfig } from "@/api/lib/ai-config-cache";
import {
  decryptAIConfig,
  encryptAIConfig,
  maskApiKey,
} from "@/api/lib/ai-config-crypto";
import {
  DEFAULT_MODELS,
  getModelForRole,
  getTemperatureForRole,
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
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const BYOK_PROVIDER_VALUES = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
] as const satisfies readonly AIProvider[];
type BYOKProvider = (typeof BYOK_PROVIDER_VALUES)[number];

const providerBody = t.Object({
  provider: t.UnionEnum(BYOK_PROVIDER_VALUES),
  apiKey: t.Optional(t.String({ minLength: 1 })),
  region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
});

const modelSelectionBody = t.Object({
  provider: t.UnionEnum(BYOK_PROVIDER_VALUES),
  modelId: t.String({ minLength: 1, maxLength: 256 }),
});

const updateAIConfigBody = t.Object({
  providers: t.Array(providerBody, { minItems: 1 }),
  overrideModels: t.Optional(
    t.Object({
      fast: t.Optional(modelSelectionBody),
      chat: t.Optional(modelSelectionBody),
      reasoning: t.Optional(modelSelectionBody),
      pdf: t.Optional(modelSelectionBody),
    }),
  ),
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

    for (const providerConfig of providerResult.providers) {
      if (!newKeyProviders.has(providerConfig.provider)) {
        continue;
      }

      const validationResult = await validateProviderKey(
        providerConfig,
        modelResult.overrideModels,
      );

      if (!validationResult.valid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: validationResult.error,
          }),
        );
      }
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

    invalidateOrgAIConfig(session.activeOrganizationId);

    return Result.ok({
      providers: orgConfig.providers.map((providerConfig) => ({
        provider: providerConfig.provider,
        apiKeyMasked: maskApiKey(providerConfig.apiKey),
        baseURL: providerConfig.baseURL ?? null,
        region: providerConfig.region ?? "global",
      })),
      overrideModels: orgConfig.overrideModels,
    });
  },
);

type ValidationResult = { valid: true } | { valid: false; error: string };

type ProviderConfigInput = {
  provider: BYOKProvider;
  apiKey?: string | undefined;
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
        ? (providerInput.region ?? existingProvider?.region ?? "global")
        : "global",
    });
  }

  return { valid: true, providers: resolvedProviders };
};

type OverrideModelsInput =
  | Partial<Record<ModelRole, OrgAIModelSelection | undefined>>
  | undefined;

type OverrideModelsResult =
  | { valid: true; overrideModels: NonNullable<OrgAIConfig["overrideModels"]> }
  | { valid: false; error: string };

const normalizeOverrideModels = (
  overrideModels: OverrideModelsInput,
  providers: readonly OrgAIProviderConfig[],
): OverrideModelsResult => {
  const normalized: Partial<Record<ModelRole, OrgAIModelSelection>> = {};
  const configuredProviders = new Set(
    providers.map((providerConfig) => providerConfig.provider),
  );

  for (const role of MODEL_ROLES) {
    const selection = overrideModels?.[role];
    const modelId = selection?.modelId.trim();

    if (!(selection && modelId)) {
      return {
        valid: false,
        error: `Model selection is required for ${role}`,
      };
    }

    if (!configuredProviders.has(selection.provider)) {
      return {
        valid: false,
        error: `Model selection for ${role} uses an unconfigured provider`,
      };
    }

    normalized[role] = {
      provider: selection.provider,
      modelId,
    };
  }

  return { valid: true, overrideModels: normalized };
};

const getValidationRole = (
  provider: AIProvider,
  overrideModels: NonNullable<OrgAIConfig["overrideModels"]>,
): ModelRole =>
  MODEL_ROLES.find((role) => overrideModels[role]?.provider === provider) ??
  "fast";

/**
 * Validate a provider API key by making a minimal API call.
 * Uses a tiny prompt to minimize cost.
 */
const validateProviderKey = async (
  providerConfig: OrgAIProviderConfig,
  overrideModels: NonNullable<OrgAIConfig["overrideModels"]>,
): Promise<ValidationResult> => {
  const role = getValidationRole(providerConfig.provider, overrideModels);
  const configuredSelection = overrideModels[role];
  const selection =
    configuredSelection?.provider === providerConfig.provider
      ? configuredSelection
      : {
          provider: providerConfig.provider,
          modelId: DEFAULT_MODELS[providerConfig.provider][role],
        };
  const tempConfig: OrgAIConfig = {
    providers: [providerConfig],
    overrideModels: {
      [role]: selection,
    },
  };

  const result = await Result.tryPromise({
    try: async () => {
      const model = getModelForRole(role, tempConfig);
      return await generateText({
        model,
        temperature: getTemperatureForRole(role),
        prompt: "Say OK",
        maxOutputTokens: 3,
        abortSignal: AbortSignal.timeout(10_000),
      });
    },
    catch: (error: unknown) =>
      `API key validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  });

  if (result.isErr()) {
    return { valid: false, error: result.error };
  }
  return { valid: true };
};

export default updateAIConfig;
