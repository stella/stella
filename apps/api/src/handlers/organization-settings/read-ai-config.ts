import { Result } from "better-result";

import type {
  DataRegion,
  DecisionModelProvider,
  OrgAIConfig,
} from "@/api/lib/ai-config";
import { decryptAIConfig, maskApiKey } from "@/api/lib/ai-config-crypto";
import {
  providerResponseExtras,
  providerResponseRegion,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { hasInstanceDecisionModel } from "@/api/lib/workflow/decisions/decision-model";

type AIConfigResult = {
  /**
   * Whether the backend has any platform-provisioned AI keys
   * (env-configured fallback). When false and `configured` is
   * also false, the org must supply their own key before AI
   * features will work.
   */
  instanceProvisioned: boolean;
  /**
   * Whether the instance carries a decision model of its own. When false and
   * the org configured none, typed decisions come back undecided and every
   * caller takes its generative or rule-based path.
   */
  decisionInstanceProvisioned: boolean;
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
      decision: {
        provider: DecisionModelProvider;
        apiKeyMasked: string;
        modelId: string;
      } | null;
    }
);

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
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
    const instanceProvisioned = hasTanStackInstanceProvider();
    const decisionInstanceProvisioned = hasInstanceDecisionModel();

    let result: AIConfigResult = {
      configured: false,
      instanceProvisioned,
      decisionInstanceProvisioned,
    };

    if (ciphertext && iv) {
      const decryptResult = await Result.tryPromise({
        try: async () =>
          await decryptAIConfig(session.activeOrganizationId, ciphertext, iv),
        catch: (error: unknown) => error,
      });

      if (decryptResult.isErr()) {
        captureError(decryptResult.error);
        // Reporting the default here would present a stored-but-unreadable
        // config as an unconfigured org and invite re-entry of the key.
        return Result.err(storedAIConfigUnreadableError(decryptResult.error));
      }

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
        decision:
          aiConfig.decision === null
            ? null
            : {
                provider: aiConfig.decision.provider,
                apiKeyMasked: maskApiKey(aiConfig.decision.apiKey),
                modelId: aiConfig.decision.modelId,
              },
        instanceProvisioned,
        decisionInstanceProvisioned,
      };
    }

    return Result.ok(result);
  },
);

export default readAIConfig;
