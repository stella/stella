import type { useTranslations } from "use-intl";

import type { McpOAuthScope } from "@stll/api/types";

import type { TranslationKey } from "@/i18n/types";

// `satisfies Record<McpOAuthScope, TranslationKey>` makes this exhaustive
// over every scope the OAuth provider can grant (`MCP_OAUTH_SCOPES` in
// `apps/api/src/mcp/constants.ts`): adding a new grantable scope without a
// disclosure label here fails the build instead of silently skipping
// disclosure. Shared by the consent screen and the connected-apps settings
// card so both surfaces describe a scope identically.
export const OAUTH_SCOPE_LABELS = {
  "stella:search": "consent.scopeSearch",
  "stella:read": "consent.scopeRead",
  "stella:templates": "consent.scopeTemplates",
  "stella:documents_write": "consent.scopeDocumentsWrite",
  "stella:matters_write": "consent.scopeMattersWrite",
  "stella:knowledge_write": "consent.scopeKnowledgeWrite",
  "stella:billing_write": "consent.scopeBillingWrite",
  "stella:admin_read": "consent.scopeAdminRead",
  "stella:admin_write": "consent.scopeAdminWrite",
  "stella:skills": "consent.scopeSkills",
  "stella:external_mcps": "consent.scopeExternalMcps",
  "stella:search_anonymized": "consent.scopeSearchAnonymized",
  "stella:read_anonymized": "consent.scopeReadAnonymized",
  "stella:templates_anonymized": "consent.scopeTemplatesAnonymized",
  "stella:onboarding": "consent.scopeOnboarding",
  email: "consent.scopeProfile",
  offline_access: "consent.scopeOfflineAccess",
  openid: "consent.scopeProfile",
  profile: "consent.scopeProfile",
} as const satisfies Record<McpOAuthScope, TranslationKey>;

export type OAuthScopeKey = keyof typeof OAUTH_SCOPE_LABELS;

export const isOAuthScopeKey = (scope: string): scope is OAuthScopeKey =>
  scope in OAUTH_SCOPE_LABELS;

export type OAuthScopeDisplayEntry =
  | { label: TranslationKey; type: "known" }
  | { scope: string; type: "unknown" };

/**
 * De-dupes a raw scope list into displayable entries: known scopes collapse
 * onto their shared disclosure label (e.g. `openid`/`profile`/`email` all
 * read as "Profile"), unknown scopes fall back to the raw string instead of
 * being silently dropped.
 */
export const toOAuthScopeDisplayEntries = (
  scopes: readonly string[],
): OAuthScopeDisplayEntry[] => {
  const entries: OAuthScopeDisplayEntry[] = [];
  const seenLabels = new Set<TranslationKey>();
  const seenUnknownScopes = new Set<string>();

  for (const scope of scopes) {
    if (isOAuthScopeKey(scope)) {
      const label = OAUTH_SCOPE_LABELS[scope];
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        entries.push({ label, type: "known" });
      }
      continue;
    }

    if (!seenUnknownScopes.has(scope)) {
      seenUnknownScopes.add(scope);
      entries.push({ scope, type: "unknown" });
    }
  }

  return entries;
};

/**
 * Translates a display entry. Lives here so the one unavoidable cast is
 * shared by every surface that renders scopes (consent screen, connected
 * apps): use-intl's `t()` overloads bind tighter for literal keys, so a
 * non-literal `TranslationKey` is rejected by the no-args overload even
 * though `OAUTH_SCOPE_LABELS` guarantees the key is valid.
 */
export const translateOAuthScopeEntry = (
  t: ReturnType<typeof useTranslations>,
  entry: OAuthScopeDisplayEntry,
): string => {
  if (entry.type === "unknown") {
    return entry.scope;
  }

  // SAFETY: OAUTH_SCOPE_LABELS `satisfies Record<McpOAuthScope,
  // TranslationKey>` enforces at compile time that every value is a valid
  // key; `as never` only works around use-intl's stricter no-args overload
  // for literal keys.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return t(entry.label as never);
};
