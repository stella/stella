/**
 * Shared helpers for the two organization-scoped web-search BYOK keys:
 * the search-provider key (Tavily) and the url-fetch key (Jina). Kept
 * in one place so the update/read/delete handlers stay DRY across both
 * kinds.
 */

import { validateJinaKey } from "@/api/lib/web-search/jina";
import { validateTavilyKey } from "@/api/lib/web-search/tavily";

export const WEB_SEARCH_KEY_KINDS = ["search", "fetch"] as const;
export type WebSearchKeyKind = (typeof WEB_SEARCH_KEY_KINDS)[number];

const MASK_VISIBLE_CHARS = 8;
const MASK_FILL = "*".repeat(16);

/** Mask a key for safe display: first 8 chars, then a fixed fill. */
export const maskWebSearchKey = (key: string): string =>
  `${key.slice(0, MASK_VISIBLE_CHARS)}${MASK_FILL}`;

/** The audit-log `field` name for each key kind. */
export const webSearchKeyAuditField = (kind: WebSearchKeyKind): string =>
  kind === "search" ? "webSearchApiKey" : "urlFetchApiKey";

/** Probe the provider for the given kind; throws on a rejected key. */
export const validateWebSearchKey = async ({
  kind,
  apiKey,
}: {
  kind: WebSearchKeyKind;
  apiKey: string;
}): Promise<void> =>
  kind === "search"
    ? await validateTavilyKey(apiKey)
    : await validateJinaKey(apiKey);

type WebSearchKeyColumns = {
  webSearchApiKeyEncrypted?: Buffer | null;
  webSearchApiKeyIv?: Buffer | null;
  urlFetchApiKeyEncrypted?: Buffer | null;
  urlFetchApiKeyIv?: Buffer | null;
};

/**
 * Build the `organizationSettings` column fragment for one key kind.
 * Pass `null` to clear the key; pass ciphertext+iv to set it.
 */
export const webSearchKeyColumns = (
  kind: WebSearchKeyKind,
  value: { ciphertext: Buffer; iv: Buffer } | null,
): WebSearchKeyColumns =>
  kind === "search"
    ? {
        webSearchApiKeyEncrypted: value?.ciphertext ?? null,
        webSearchApiKeyIv: value?.iv ?? null,
      }
    : {
        urlFetchApiKeyEncrypted: value?.ciphertext ?? null,
        urlFetchApiKeyIv: value?.iv ?? null,
      };
