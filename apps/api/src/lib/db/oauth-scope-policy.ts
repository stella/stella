import type { McpOAuthScope } from "@stll/api-contract";

/**
 * Which scopes a client may obtain without an operator: "open" scopes are
 * granted to self-registered and partner clients alike, "elevated" ones never.
 * Loads no auth runtime, so database owners and public routes can depend on it.
 */
export const OAUTH_REGISTRATION_SCOPE_POLICY = {
  openid: "open",
  profile: "open",
  email: "open",
  offline_access: "open",
  "stella:search": "open",
  "stella:read": "open",
  "stella:law_read": "open",
  "stella:templates": "open",
  "stella:documents_write": "open",
  "stella:matters_write": "open",
  "stella:contacts_write": "open",
  "stella:chat": "open",
  "stella:memory_write": "elevated",
  "stella:knowledge_write": "open",
  "stella:billing_write": "open",
  "stella:admin_read": "elevated",
  "stella:admin_write": "elevated",
  "stella:onboarding": "open",
  "stella:skills": "open",
  "stella:external_mcps": "elevated",
  "stella:feedback": "open",
  "stella:search_anonymized": "open",
  "stella:read_anonymized": "open",
  "stella:templates_anonymized": "open",
} as const satisfies Record<McpOAuthScope, "open" | "elevated">;

export const OPEN_REGISTRATION_SCOPES = Object.entries(
  OAUTH_REGISTRATION_SCOPE_POLICY,
).flatMap(([scope, policy]) => (policy === "open" ? [scope] : []));
