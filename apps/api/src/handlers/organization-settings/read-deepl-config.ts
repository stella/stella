import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decryptContent } from "@/api/lib/content-encryption";
import { maskDeepLKey, resolveDeepLBaseUrl } from "@/api/lib/deepl";

const FREE_BASE_URL = "https://api-free.deepl.com";

type DeepLConfig =
  | { configured: false }
  | {
      configured: true;
      apiKeyMasked: string;
      tier: "free" | "pro";
    };

const config = {
  permissions: { organizationSettings: ["update"] },
} satisfies HandlerConfig;

/**
 * Admin-only view of the org's DeepL key: masked preview + tier.
 * Mirrors the read-ai-config split so anything that leaks bytes
 * of the secret is gated by organizationSettings:update.
 */
const readDeepLConfig = createSafeRootHandler(
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
      return Result.ok<DeepLConfig>({ configured: false });
    }

    const apiKey = await decryptContent(
      session.activeOrganizationId,
      ciphertext,
      iv,
    );

    return Result.ok<DeepLConfig>({
      configured: true,
      apiKeyMasked: maskDeepLKey(apiKey),
      tier: resolveDeepLBaseUrl(apiKey) === FREE_BASE_URL ? "free" : "pro",
    });
  },
);

export default readDeepLConfig;
