import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import type { McpSession } from "@/api/mcp/auth";

type AccountExportAuthority = {
  credential?: McpSession["credential"];
  grantedScopes: readonly string[];
};

/** Account consent belongs to the OAuth subject, outside organization grants. */
export const hasAccountExportAuthority = (
  { credential, grantedScopes }: AccountExportAuthority,
  access: keyof typeof ACCOUNT_EXPORT_SCOPES,
): boolean =>
  credential?.type === "oauth_client" &&
  grantedScopes.includes(ACCOUNT_EXPORT_SCOPES[access]);

export const isAccountExportScope = (scope: string): boolean =>
  Object.values(ACCOUNT_EXPORT_SCOPES).some((value) => value === scope);
