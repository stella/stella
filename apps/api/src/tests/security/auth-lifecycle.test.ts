import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readSecurityFixture = (relativePath: string) =>
  readFileSync(join(import.meta.dir, relativePath), "utf-8");

describe("organization member auth lifecycle", () => {
  test("member removal routes cleanup through the shared helper", () => {
    const authSource = readSecurityFixture("../../lib/auth.ts");

    const hookIndex = authSource.indexOf("afterRemoveMember");
    const helperCallIndex = authSource.indexOf(
      "revokeOrganizationMemberAuthArtifacts",
      hookIndex,
    );

    expect(hookIndex).toBeGreaterThanOrEqual(0);
    expect(helperCallIndex).toBeGreaterThan(hookIndex);
  });

  test("shared cleanup covers org-scoped sessions and OAuth tokens", () => {
    const helperSource = readSecurityFixture("../../lib/auth-artifacts.ts");

    expect(helperSource).toContain("delete(oauthAccessToken)");
    expect(helperSource).toContain("delete(oauthRefreshToken)");
    expect(helperSource).toContain("delete(sessionTable)");
    expect(helperSource).toContain("referenceId");
    expect(helperSource).toContain("activeOrganizationId");
  });
});
