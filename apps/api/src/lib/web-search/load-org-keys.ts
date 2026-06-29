/**
 * Load an organization's stored web-search BYOK keys and resolve them
 * into ready-to-use providers (org key first, platform env key as
 * fallback).
 *
 * Mirrors `ai-config-loader`: a single indexed `findFirst` on
 * `organization_id` via the root pool, with key material decrypted in
 * process. The cost is dominated by the in-VPC round-trip to RDS.
 */

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import type {
  ResolvedWebSearchProviders,
  WebSearchKeys,
} from "@/api/lib/web-search/select-provider";
import { resolveWebSearchProvidersFromEnv } from "@/api/lib/web-search/select-provider";

const decryptOptional = async (
  organizationId: SafeId<"organization">,
  ciphertext: Buffer | null | undefined,
  iv: Buffer | null | undefined,
): Promise<string | null> =>
  ciphertext && iv
    ? await decryptContent(organizationId, ciphertext, iv)
    : null;

export const loadWebSearchKeys = async (
  organizationId: SafeId<"organization">,
): Promise<WebSearchKeys> => {
  const row = await rootDb.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      webSearchApiKeyEncrypted: true,
      webSearchApiKeyIv: true,
      urlFetchApiKeyEncrypted: true,
      urlFetchApiKeyIv: true,
    },
  });

  const [searchApiKey, fetchApiKey] = await Promise.all([
    decryptOptional(
      organizationId,
      row?.webSearchApiKeyEncrypted,
      row?.webSearchApiKeyIv,
    ),
    decryptOptional(
      organizationId,
      row?.urlFetchApiKeyEncrypted,
      row?.urlFetchApiKeyIv,
    ),
  ]);

  return { searchApiKey, fetchApiKey };
};

export const loadWebSearchProvidersForOrg = async (
  organizationId: SafeId<"organization">,
): Promise<ResolvedWebSearchProviders> =>
  resolveWebSearchProvidersFromEnv(await loadWebSearchKeys(organizationId));
