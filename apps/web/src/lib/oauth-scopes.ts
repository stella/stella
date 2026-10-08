import type { TranslationKey } from "@/i18n/types";
import type { McpOAuthScope } from "@/lib/api-contract";

export type OAuthScopeGroup = "read" | "change" | "other";

// `satisfies Record<McpOAuthScope, ...>` makes this exhaustive
// over every scope the OAuth provider can grant (`MCP_OAUTH_SCOPES` in
// `apps/api/src/mcp/constants.ts`): adding a new grantable scope without a
// disclosure label here fails the build instead of silently skipping
// disclosure. Shared by the consent screen and the connected-apps settings
// card so both surfaces describe a scope identically.
const OAUTH_SCOPE_METADATA = {
  "stella:search": { label: "consent.scopeSearch", group: "read" },
  "stella:read": { label: "consent.scopeRead", group: "read" },
  "stella:templates": { label: "consent.scopeTemplates", group: "change" },
  "stella:documents_write": {
    label: "consent.scopeDocumentsWrite",
    group: "change",
  },
  "stella:matters_write": {
    label: "consent.scopeMattersWrite",
    group: "change",
  },
  "stella:contacts_write": {
    label: "consent.scopeContactsWrite",
    group: "change",
  },
  "stella:chat": { label: "consent.scopeChat", group: "change" },
  "stella:knowledge_write": {
    label: "consent.scopeKnowledgeWrite",
    group: "change",
  },
  "stella:billing_write": {
    label: "consent.scopeBillingWrite",
    group: "change",
  },
  "stella:admin_read": { label: "consent.scopeAdminRead", group: "read" },
  "stella:admin_write": { label: "consent.scopeAdminWrite", group: "change" },
  "stella:skills": { label: "consent.scopeSkills", group: "change" },
  "stella:external_mcps": {
    label: "consent.scopeExternalMcps",
    group: "change",
  },
  "stella:feedback": { label: "consent.scopeFeedback", group: "change" },
  "stella:search_anonymized": {
    label: "consent.scopeSearchAnonymized",
    group: "read",
  },
  "stella:read_anonymized": {
    label: "consent.scopeReadAnonymized",
    group: "read",
  },
  "stella:templates_anonymized": {
    label: "consent.scopeTemplatesAnonymized",
    group: "change",
  },
  "stella:onboarding": { label: "consent.scopeOnboarding", group: "change" },
  email: { label: "consent.scopeProfile", group: "read" },
  offline_access: { label: "consent.scopeOfflineAccess", group: "other" },
  openid: { label: "consent.scopeProfile", group: "read" },
  profile: { label: "consent.scopeProfile", group: "read" },
} as const satisfies Record<
  McpOAuthScope,
  { label: TranslationKey; group: OAuthScopeGroup }
>;

type OAuthScopeKey = keyof typeof OAUTH_SCOPE_METADATA;
type OAuthScopeLabel = (typeof OAUTH_SCOPE_METADATA)[OAuthScopeKey]["label"];
type OAuthScopeTranslator = (key: OAuthScopeLabel) => string;

const isOAuthScopeKey = (scope: string): scope is OAuthScopeKey =>
  Object.hasOwn(OAUTH_SCOPE_METADATA, scope);

export type OAuthScopeDisplayEntry =
  | { label: OAuthScopeLabel; group: OAuthScopeGroup; type: "known" }
  | { scope: string; group: "other"; type: "unknown" };

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
  const seenLabels = new Set<OAuthScopeLabel>();
  const seenUnknownScopes = new Set<string>();

  for (const scope of scopes) {
    if (isOAuthScopeKey(scope)) {
      const { label, group } = OAUTH_SCOPE_METADATA[scope];
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        entries.push({ label, group, type: "known" });
      }
      continue;
    }

    if (!seenUnknownScopes.has(scope)) {
      seenUnknownScopes.add(scope);
      entries.push({ scope, group: "other", type: "unknown" });
    }
  }

  return entries;
};

export type OAuthScopeDisplayGroups = Record<
  OAuthScopeGroup,
  OAuthScopeDisplayEntry[]
>;

/** Groups display entries without dropping or rewriting any requested entry. */
export const groupOAuthScopeDisplayEntries = (
  entries: readonly OAuthScopeDisplayEntry[],
): OAuthScopeDisplayGroups => {
  const groups: OAuthScopeDisplayGroups = { read: [], change: [], other: [] };
  for (const entry of entries) {
    groups[entry.group].push(entry);
  }
  return groups;
};

/**
 * Translates a display entry. Lives here so consent and settings render the
 * same labels for the same scopes.
 */
export const translateOAuthScopeEntry = (
  t: OAuthScopeTranslator,
  entry: OAuthScopeDisplayEntry,
): string => {
  if (entry.type === "unknown") {
    return entry.scope;
  }

  return t(entry.label);
};
