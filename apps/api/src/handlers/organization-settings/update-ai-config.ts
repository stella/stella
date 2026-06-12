import { panic, Result } from "better-result";
import { t } from "elysia";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { organizationSettings } from "@/api/db/schema";
import type {
  OrgAIConfig,
  OrgAIModelSelection,
  OrgAIProviderConfig,
} from "@/api/lib/ai-config";
import {
  decryptAIConfig,
  encryptAIConfig,
  maskApiKey,
} from "@/api/lib/ai-config-crypto";
import {
  providerResponseExtras,
  providerResponseRegion,
} from "@/api/lib/ai-config-response";
import { probeProvider } from "@/api/lib/ai-provider-probe";
import type { ProviderProbeResult } from "@/api/lib/ai-provider-probe";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isAllowedBYOKModel } from "@/api/lib/tanstack-ai-models";
import type { BYOKProvider, ModelRole } from "@/api/lib/tanstack-ai-models";

const BYOK_PROVIDER_VALUES = TANSTACK_AI_PROVIDERS;

const providerBody = t.Object({
  provider: t.UnionEnum(BYOK_PROVIDER_VALUES),
  apiKey: t.Optional(t.String({ minLength: 1 })),
  region: t.Optional(t.Literal("global")),
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
  async function* ({ safeDb, session, body, recordAuditEvent }) {
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

    const newKeyProviders = new Set<BYOKProvider>(
      body.providers
        .filter((provider) => provider.apiKey)
        .map((provider) => provider.provider),
    );

    const providersToValidate = providerResult.providers.filter(
      (providerConfig) =>
        shouldValidateProviderConfig({
          newKeyProviders,
          providerConfig,
        }),
    );

    const validationResults = await Promise.all(
      providersToValidate.map(
        async (providerConfig) => await validateProviderKey(providerConfig),
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
      safeDb(async (tx) => {
        await tx
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
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "aiConfig",
            providers: orgConfig.providers.map(
              (providerConfig) => providerConfig.provider,
            ),
          },
        });
      }),
    );

    return Result.ok({
      providers: orgConfig.providers.map((providerConfig) => ({
        provider: providerConfig.provider,
        apiKeyMasked: maskApiKey(providerConfig.apiKey),
        region: providerResponseRegion(providerConfig),
        ...providerResponseExtras(providerConfig),
      })),
      overrideModels: orgConfig.overrideModels,
    });
  },
);

type ValidationResult = ProviderProbeResult;

type ProviderConfigInput = {
  provider: BYOKProvider;
  apiKey?: string | undefined;
  region?: "global" | undefined;
};

type TanStackBYOKProviderConfig = OrgAIProviderConfig & {
  provider: BYOKProvider;
};

type ProviderConfigResult =
  | {
      valid: true;
      providers: TanStackBYOKProviderConfig[];
    }
  | { valid: false; error: string };

const resolveProviderConfigs = (
  providers: readonly ProviderConfigInput[],
  existingConfig: OrgAIConfig | undefined,
): ProviderConfigResult => {
  const resolvedProviders: TanStackBYOKProviderConfig[] = [];
  const seenProviders = new Set<BYOKProvider>();

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

    const existingRegion =
      existingProvider?.provider === providerInput.provider
        ? existingProvider.region
        : undefined;

    resolvedProviders.push({
      provider: providerInput.provider,
      apiKey,
      region: providerInput.region ?? existingRegion ?? "global",
    });
  }

  return { valid: true, providers: resolvedProviders };
};

type OverrideModelSelectionInput = {
  provider: BYOKProvider;
  modelId: string;
};

type OverrideModelsInput = Record<ModelRole, OverrideModelSelectionInput>;

type OverrideModelsResult =
  | { valid: true; overrideModels: Record<ModelRole, OrgAIModelSelection> }
  | { valid: false; error: string };

const normalizeRoleSelection = (
  role: ModelRole,
  overrideModels: OverrideModelsInput,
  configuredProviders: ReadonlySet<BYOKProvider>,
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
  providers: readonly TanStackBYOKProviderConfig[],
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
  newKeyProviders: ReadonlySet<BYOKProvider>;
  providerConfig: TanStackBYOKProviderConfig;
};

const shouldValidateProviderConfig = ({
  newKeyProviders,
  providerConfig,
}: ShouldValidateProviderConfigOptions): boolean => {
  if (newKeyProviders.has(providerConfig.provider)) {
    return true;
  }
  return false;
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
 */
const validateProviderKey = async (
  providerConfig: TanStackBYOKProviderConfig,
): Promise<ValidationResult> => {
  const result = await Result.tryPromise({
    try: async () =>
      await probeProvider(
        providerConfig.provider,
        providerConfig.apiKey,
        undefined,
        undefined,
        undefined,
        SETTINGS_PROBE_TIMEOUT_MS,
      ),
    catch: (error: unknown) =>
      `API key validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  });

  if (result.isErr()) {
    return { valid: false, error: result.error };
  }
  return result.value;
};

export default updateAIConfig;
