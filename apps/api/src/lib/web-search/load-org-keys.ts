/**
 * Load an organization's stored web-search BYOK keys and resolve them
 * into ready-to-use providers (org key first, platform env key as
 * fallback).
 *
 * Mirrors `ai-config-loader`: a single indexed select on `organization_id`
 * through the handle the caller passes (a request's scoped transaction or a
 * worker's database), with key material decrypted in process.
 */

import { eq } from "drizzle-orm";

import { organizationSettings } from "@/api/db/schema";
import type { OrgSettingsReader } from "@/api/lib/ai-config-loader";
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

/** The `organizationSettings` columns web-search key resolution reads. */
export type OrgWebSearchKeyRow = {
  webSearchApiKeyEncrypted: Buffer | null;
  webSearchApiKeyIv: Buffer | null;
  urlFetchApiKeyEncrypted: Buffer | null;
  urlFetchApiKeyIv: Buffer | null;
};

/**
 * Resolve web-search keys from an `organizationSettings` row a caller
 * already fetched (e.g. alongside other columns in its own scoped
 * read), instead of issuing this module's own `organizationSettings`
 * lookup. Used by callers that already hold the row.
 */
export const resolveWebSearchKeysFromRow = async (
  organizationId: SafeId<"organization">,
  row: OrgWebSearchKeyRow | null | undefined,
): Promise<WebSearchKeys> => {
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

export const loadWebSearchKeys = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
): Promise<WebSearchKeys> => {
  const rows = await db
    .select({
      webSearchApiKeyEncrypted: organizationSettings.webSearchApiKeyEncrypted,
      webSearchApiKeyIv: organizationSettings.webSearchApiKeyIv,
      urlFetchApiKeyEncrypted: organizationSettings.urlFetchApiKeyEncrypted,
      urlFetchApiKeyIv: organizationSettings.urlFetchApiKeyIv,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);

  return await resolveWebSearchKeysFromRow(organizationId, rows.at(0));
};

export const loadWebSearchProvidersForOrg = async (
  db: OrgSettingsReader,
  organizationId: SafeId<"organization">,
): Promise<ResolvedWebSearchProviders> =>
  resolveWebSearchProvidersFromEnv(await loadWebSearchKeys(db, organizationId));

/**
 * Resolve web-search providers from an `organizationSettings` row a
 * caller already fetched, instead of this module re-reading the row.
 * `handlers/chat/messages/list.ts` uses this after widening its own scoped
 * select to include the web-search key columns.
 */
export const resolveWebSearchProvidersFromOrgSettingsRow = async (
  organizationId: SafeId<"organization">,
  row: OrgWebSearchKeyRow | null | undefined,
): Promise<ResolvedWebSearchProviders> =>
  resolveWebSearchProvidersFromEnv(
    await resolveWebSearchKeysFromRow(organizationId, row),
  );
