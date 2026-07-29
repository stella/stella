import { describe, expect, test } from "bun:test";

import {
  FULL_STELLA_ACCESS_SCOPES,
  includesFullStellaAccess,
  requestsStellaWorkspaceAccess,
} from "@/lib/oauth-scopes";

describe("full stella OAuth access", () => {
  test("includes every normal resource scope without protocol or anonymized scopes", () => {
    expect(FULL_STELLA_ACCESS_SCOPES).toContain("stella:read");
    expect(FULL_STELLA_ACCESS_SCOPES).toContain("stella:matters_write");
    expect(FULL_STELLA_ACCESS_SCOPES).toContain("stella:admin_write");
    expect(FULL_STELLA_ACCESS_SCOPES).not.toContain("openid");
    expect(FULL_STELLA_ACCESS_SCOPES).not.toContain("stella:read_anonymized");
  });

  test("distinguishes partial, full and anonymized-only requests", () => {
    expect(requestsStellaWorkspaceAccess(["openid", "stella:read"])).toBe(true);
    expect(
      requestsStellaWorkspaceAccess(["openid", "stella:read_anonymized"]),
    ).toBe(false);
    expect(includesFullStellaAccess(["stella:read"])).toBe(false);
    expect(includesFullStellaAccess(FULL_STELLA_ACCESS_SCOPES)).toBe(true);
  });
});
