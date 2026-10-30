import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_EXPORT_SCOPES,
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
  MCP_WRITE_ONLY_RESOURCE_SCOPES,
} from "@stll/api-contract";

import { hasAccountExportAuthority } from "@/api/lib/auth/account-export-policy";

describe("account export consent", () => {
  test("account consent requires a credential", () => {
    const authority = {
      credential: undefined,
      grantedScopes: Object.values(ACCOUNT_EXPORT_SCOPES),
    };
    expect(hasAccountExportAuthority(authority, "read")).toBe(false);
    expect(hasAccountExportAuthority(authority, "write")).toBe(false);
  });

  test("organization grants and opposite access grants convey no account consent", () => {
    const credential = { type: "oauth_client", clientId: "client" } as const;
    const organizationScopes = [
      "stella:read",
      "stella:admin_read",
      "stella:admin_write",
      "stella:matters_write",
    ];
    const organizationAuthority = {
      credential,
      grantedScopes: organizationScopes,
    };
    expect(hasAccountExportAuthority(organizationAuthority, "read")).toBe(
      false,
    );
    expect(hasAccountExportAuthority(organizationAuthority, "write")).toBe(
      false,
    );
    const readAuthority = {
      credential,
      grantedScopes: [ACCOUNT_EXPORT_SCOPES.read],
    };
    expect(hasAccountExportAuthority(readAuthority, "read")).toBe(true);
    expect(hasAccountExportAuthority(readAuthority, "write")).toBe(false);
    const writeAuthority = {
      credential,
      grantedScopes: [ACCOUNT_EXPORT_SCOPES.write],
    };
    expect(hasAccountExportAuthority(writeAuthority, "read")).toBe(false);
    expect(hasAccountExportAuthority(writeAuthority, "write")).toBe(true);
  });

  test("account scope access and audience declarations agree", () => {
    expect(MCP_WRITE_ONLY_RESOURCE_SCOPES).toContain(
      ACCOUNT_EXPORT_SCOPES.write,
    );
    expect(MCP_WRITE_ONLY_RESOURCE_SCOPES).not.toContain(
      ACCOUNT_EXPORT_SCOPES.read,
    );
    expect(
      MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE[ACCOUNT_EXPORT_SCOPES.read],
    ).toBeNull();
    expect(
      MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE[ACCOUNT_EXPORT_SCOPES.write],
    ).toBeNull();
  });
});
