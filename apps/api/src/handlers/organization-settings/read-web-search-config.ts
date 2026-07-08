import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { maskWebSearchKey } from "@/api/lib/web-search/keys";
import { webSearchDeployConfigFromEnv } from "@/api/lib/web-search/select-provider";

type WebSearchKeyState =
  | { configured: false; platformFallback: boolean }
  | { configured: true; apiKeyMasked: string; platformFallback: boolean };

type WebSearchKeysConfig = {
  search: WebSearchKeyState;
  fetch: WebSearchKeyState;
};

const config = {
  // Anything that leaks bytes of a stored key (even masked) is gated
  // behind organizationSettings:update, mirroring read-deepl-config.
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "anonymization_admin" },
} satisfies HandlerConfig;

const buildKeyState = async ({
  organizationId,
  ciphertext,
  iv,
  platformFallback,
}: {
  organizationId: SafeId<"organization">;
  ciphertext: Buffer | null | undefined;
  iv: Buffer | null | undefined;
  platformFallback: boolean;
}): Promise<WebSearchKeyState> => {
  if (!ciphertext || !iv) {
    return { configured: false, platformFallback };
  }
  const apiKey = await decryptContent(organizationId, ciphertext, iv);
  return {
    configured: true,
    apiKeyMasked: maskWebSearchKey(apiKey),
    platformFallback,
  };
};

/**
 * Admin-only view of the org's web-search BYOK keys: a masked preview
 * per kind plus whether the deployment already provides a working
 * fallback (so the card can explain when adding a key is optional).
 */
const readWebSearchConfig = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const organizationId = session.activeOrganizationId;
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: {
            webSearchApiKeyEncrypted: true,
            webSearchApiKeyIv: true,
            urlFetchApiKeyEncrypted: true,
            urlFetchApiKeyIv: true,
          },
        }),
      ),
    );

    const deploy = webSearchDeployConfigFromEnv();
    // Tavily needs a key, so the platform fallback exists only when the
    // deploy supplied its own. Jina works keyless, so a fetch fallback
    // exists whenever the provider is selected.
    const searchPlatformFallback =
      deploy.featureEnabled &&
      deploy.searchProvider === "tavily" &&
      Boolean(deploy.platformSearchApiKey);
    const fetchPlatformFallback =
      deploy.featureEnabled && deploy.fetchProvider === "jina";

    const [search, fetch] = await Promise.all([
      buildKeyState({
        organizationId,
        ciphertext: row?.webSearchApiKeyEncrypted,
        iv: row?.webSearchApiKeyIv,
        platformFallback: searchPlatformFallback,
      }),
      buildKeyState({
        organizationId,
        ciphertext: row?.urlFetchApiKeyEncrypted,
        iv: row?.urlFetchApiKeyIv,
        platformFallback: fetchPlatformFallback,
      }),
    ]);

    return Result.ok<WebSearchKeysConfig>({ search, fetch });
  },
);

export default readWebSearchConfig;
