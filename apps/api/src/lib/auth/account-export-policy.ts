import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import type { McpSession } from "@/api/mcp/auth";

export type AccountCapabilityAuthority = {
  credential?: McpSession["credential"];
  grantedScopes: readonly string[];
};

/** Account consent belongs to the OAuth subject, outside organization grants. */
export const hasAccountExportAuthority = (
  { credential, grantedScopes }: AccountCapabilityAuthority,
  access: keyof typeof ACCOUNT_EXPORT_SCOPES,
): boolean =>
  hasAccountCapabilityAuthority(
    { credential, grantedScopes },
    ACCOUNT_EXPORT_SCOPES[access],
  );

/** Session capabilities declare their account consent independently of organization roles. */
export const hasAccountCapabilityAuthority = (
  { credential, grantedScopes }: AccountCapabilityAuthority,
  scope: string,
): boolean =>
  credential?.type === "oauth_client" && grantedScopes.includes(scope);
