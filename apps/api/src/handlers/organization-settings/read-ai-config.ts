import { Result } from "better-result";

import { decryptAIConfig, maskApiKey } from "@/api/lib/ai-config-crypto";
import { hasInstanceProvider } from "@/api/lib/ai-models";
import type {
  DataRegion,
  OrgAIConfig,
  OrgAIProviderConfig,
} from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

type AIConfigResult = {
  /**
   * Whether the backend has any platform-provisioned AI keys
   * (env-configured fallback). When false and `configured` is
   * also false, the org must supply their own key before AI
   * features will work.
   */
  instanceProvisioned: boolean;
} & (
  | { configured: false }
  | {
      configured: true;
      providers: {
        provider: OrgAIConfig["providers"][number]["provider"];
        apiKeyMasked: string;
        endpoint?: string | undefined;
        apiVersion?: string | undefined;
        region: DataRegion;
      }[];
      overrideModels: OrgAIConfig["overrideModels"];
    }
);

const providerResponseRegion = (
  providerConfig: OrgAIProviderConfig,
): DataRegion => {
  switch (providerConfig.provider) {
    case "azure_foundry":
    case "huggingface":
      return "global";
    default:
      return providerConfig.region ?? "global";
  }
};

type ProviderResponseExtras = {
  endpoint?: string;
  apiVersion?: string;
};

const providerResponseExtras = (
  providerConfig: OrgAIProviderConfig,
): ProviderResponseExtras => {
  switch (providerConfig.provider) {
    case "azure_foundry":
      return {
        endpoint: providerConfig.baseURL,
        ...(providerConfig.apiVersion
          ? { apiVersion: providerConfig.apiVersion }
          : {}),
      };
    case "huggingface":
      return { endpoint: providerConfig.baseURL };
    default:
      return {};
  }
};

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

/**
 * Read the org's AI config. Returns provider, region, and
 * override roles. The API key is masked (first 8 chars only)
 * to prevent exposure.
 */
const readAIConfig = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
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
    const instanceProvisioned = hasInstanceProvider();

    let result: AIConfigResult = {
      configured: false,
      instanceProvisioned,
    };

    if (ciphertext && iv) {
      const decryptResult = await Result.tryPromise({
        try: async () =>
          await decryptAIConfig(session.activeOrganizationId, ciphertext, iv),
        catch: (error: unknown) => error,
      });

      if (decryptResult.isErr()) {
        captureError(decryptResult.error);
      } else {
        const aiConfig = decryptResult.value;
        result = {
          configured: true,
          providers: aiConfig.providers.map((providerConfig) => ({
            provider: providerConfig.provider,
            apiKeyMasked: maskApiKey(providerConfig.apiKey),
            region: providerResponseRegion(providerConfig),
            ...providerResponseExtras(providerConfig),
          })),
          overrideModels: aiConfig.overrideModels,
          instanceProvisioned,
        };
      }
    }

    return Result.ok(result);
  },
);

export default readAIConfig;
