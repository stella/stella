import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decryptContent } from "@/api/lib/content-encryption";
import { maskDeepLKey, resolveDeepLBaseUrl } from "@/api/lib/deepl";

const FREE_BASE_URL = "https://api-free.deepl.com";

type DeepLAvailability = {
  configured: boolean;
  apiKeyMasked: string | null;
  tier: "free" | "pro" | null;
};

const config = {
  // Any member with workspace read can see whether translation is
  // available; full key visibility is gated by the masking helper.
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

/**
 * Report whether the org has a DeepL key configured, including
 * a masked preview and the tier (free/pro) so the settings UI
 * can render the right copy without holding the secret.
 */
const readDeepLAvailability = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            deeplApiKeyEncrypted: true,
            deeplApiKeyIv: true,
          },
        }),
      ),
    );

    const ciphertext = row?.deeplApiKeyEncrypted;
    const iv = row?.deeplApiKeyIv;
    if (!ciphertext || !iv) {
      return Result.ok<DeepLAvailability>({
        configured: false,
        apiKeyMasked: null,
        tier: null,
      });
    }

    const apiKey = await decryptContent(
      session.activeOrganizationId,
      ciphertext,
      iv,
    );

    return Result.ok<DeepLAvailability>({
      configured: true,
      apiKeyMasked: maskDeepLKey(apiKey),
      tier: resolveDeepLBaseUrl(apiKey) === FREE_BASE_URL ? "free" : "pro",
    });
  },
);

export default readDeepLAvailability;
