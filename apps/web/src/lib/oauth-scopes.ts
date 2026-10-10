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
  "stella:search": {
    label: "consent.scopeSearch",
    summary: "consent.summarySearch",
    group: "read",
    sensitive: false,
  },
  "stella:read": {
    label: "consent.scopeRead",
    summary: "consent.summaryRead",
    group: "read",
    sensitive: false,
  },
  "stella:templates": {
    label: "consent.scopeTemplates",
    summary: "consent.summaryTemplates",
    group: "change",
    sensitive: false,
  },
  "stella:documents_write": {
    label: "consent.scopeDocumentsWrite",
    summary: "consent.summaryDocumentsWrite",
    group: "change",
    sensitive: true,
  },
  "stella:matters_write": {
    label: "consent.scopeMattersWrite",
    summary: "consent.summaryMattersWrite",
    group: "change",
    sensitive: false,
  },
  "stella:contacts_write": {
    label: "consent.scopeContactsWrite",
    summary: "consent.summaryContactsWrite",
    group: "change",
    sensitive: true,
  },
  "stella:chat": {
    label: "consent.scopeChat",
    summary: "consent.summaryChat",
    group: "change",
    sensitive: false,
  },
  "stella:knowledge_write": {
    label: "consent.scopeKnowledgeWrite",
    summary: "consent.summaryKnowledgeWrite",
    group: "change",
    sensitive: true,
  },
  "stella:billing_write": {
    label: "consent.scopeBillingWrite",
    summary: "consent.summaryBillingWrite",
    group: "change",
    sensitive: true,
  },
  "stella:admin_read": {
    label: "consent.scopeAdminRead",
    summary: "consent.summaryAdminRead",
    group: "read",
    sensitive: false,
  },
  "stella:admin_write": {
    label: "consent.scopeAdminWrite",
    summary: "consent.summaryAdminWrite",
    group: "change",
    sensitive: true,
  },
  "stella:skills": {
    label: "consent.scopeSkills",
    summary: "consent.summarySkills",
    group: "change",
    sensitive: false,
  },
  "stella:external_mcps": {
    label: "consent.scopeExternalMcps",
    summary: "consent.summaryExternalMcps",
    group: "change",
    sensitive: false,
  },
  "stella:feedback": {
    label: "consent.scopeFeedback",
    summary: "consent.summaryFeedback",
    group: "change",
    sensitive: false,
  },
  "stella:search_anonymized": {
    label: "consent.scopeSearchAnonymized",
    summary: "consent.summarySearchAnonymized",
    group: "read",
    sensitive: false,
  },
  "stella:read_anonymized": {
    label: "consent.scopeReadAnonymized",
    summary: "consent.summaryReadAnonymized",
    group: "read",
    sensitive: false,
  },
  "stella:templates_anonymized": {
    label: "consent.scopeTemplatesAnonymized",
    summary: "consent.summaryTemplatesAnonymized",
    group: "change",
    sensitive: false,
  },
  "stella:onboarding": {
    label: "consent.scopeOnboarding",
    summary: "consent.summaryOnboarding",
    group: "change",
    sensitive: false,
  },
  email: {
    label: "consent.scopeProfile",
    summary: "consent.summaryProfile",
    group: "read",
    sensitive: false,
  },
  offline_access: {
    label: "consent.scopeOfflineAccess",
    summary: "consent.summaryOfflineAccess",
    group: "other",
    sensitive: false,
  },
  openid: {
    label: "consent.scopeProfile",
    summary: "consent.summaryProfile",
    group: "read",
    sensitive: false,
  },
  profile: {
    label: "consent.scopeProfile",
    summary: "consent.summaryProfile",
    group: "read",
    sensitive: false,
  },
} as const satisfies Record<
  McpOAuthScope,
  {
    label: TranslationKey;
    /** A short noun for the one-line summary ("documents", "audit log"). */
    summary: TranslationKey;
    group: OAuthScopeGroup;
    /** Deleting data or administering the organization: summarized first. */
    sensitive: boolean;
  }
>;

type OAuthScopeKey = keyof typeof OAUTH_SCOPE_METADATA;
type OAuthScopeLabel = (typeof OAUTH_SCOPE_METADATA)[OAuthScopeKey]["label"];
type OAuthScopeSummary =
  (typeof OAUTH_SCOPE_METADATA)[OAuthScopeKey]["summary"];
type OAuthScopeTranslator = (
  key: OAuthScopeLabel | OAuthScopeSummary,
) => string;

const isOAuthScopeKey = (scope: string): scope is OAuthScopeKey =>
  Object.hasOwn(OAUTH_SCOPE_METADATA, scope);

export type OAuthScopeDisplayEntry =
  | {
      label: OAuthScopeLabel;
      summary: OAuthScopeSummary;
      group: OAuthScopeGroup;
      sensitive: boolean;
      type: "known";
    }
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
      const { label, summary, group, sensitive } = OAUTH_SCOPE_METADATA[scope];
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        entries.push({ label, summary, group, sensitive, type: "known" });
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

/** The short noun an entry contributes to its group's one-line summary. */
export const translateOAuthScopeSummary = (
  t: OAuthScopeTranslator,
  entry: OAuthScopeDisplayEntry,
): string => {
  if (entry.type === "unknown") {
    return entry.scope;
  }

  return t(entry.summary);
};

/**
 * Orders a group for its summary: sensitive entries first, so deleting data
 * or administering the organization is read before anything routine.
 */
export const orderOAuthScopeSummary = (
  entries: readonly OAuthScopeDisplayEntry[],
): OAuthScopeDisplayEntry[] => [
  ...entries.filter((entry) => entry.type === "known" && entry.sensitive),
  ...entries.filter((entry) => entry.type !== "known" || !entry.sensitive),
];
