import { Result } from "better-result";

import { decryptAIConfig, maskApiKey } from "@/api/lib/ai-config-crypto";
import { captureError } from "@/api/lib/analytics";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

/**
 * Read the org's AI config. Returns provider, region, and
 * override roles. The API key is masked (first 8 chars only)
 * to prevent exposure.
 */
const readAIConfig = createRootHandler(
  config,
  async ({ scopedDb, session }) => {
    const row = await scopedDb((tx) =>
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
    );

    const ciphertext = row?.aiConfigEncrypted;
    const iv = row?.aiConfigIv;

    if (!ciphertext || !iv) {
      return { configured: false as const };
    }

    const decryptResult = await Result.tryPromise({
      try: async () =>
        await decryptAIConfig(session.activeOrganizationId, ciphertext, iv),
      catch: (error: unknown) => error,
    });

    if (decryptResult.isErr()) {
      captureError(decryptResult.error);
      return { configured: false as const };
    }

    const aiConfig = decryptResult.value;

    return {
      configured: true as const,
      provider: aiConfig.provider,
      apiKeyMasked: maskApiKey(aiConfig.apiKey),
      baseURL: aiConfig.baseURL ?? null,
      overrideRoles: aiConfig.overrideRoles ?? [],
      region: aiConfig.region ?? "global",
    };
  },
);

export default readAIConfig;
