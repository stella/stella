import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isBootstrapTokenMatch } from "@/api/lib/selfhost-auth";

const readSecurityFixture = (relativePath: string) =>
  readFileSync(path.join(import.meta.dir, relativePath), "utf-8");

const readRootFixture = (relativePath: string) =>
  readFileSync(
    path.join(import.meta.dir, "../../../../..", relativePath),
    "utf-8",
  );

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

  test("lint rule catches auth artifact deletes through schema member access", () => {
    const pluginSource = readRootFixture(".oxlint-plugins/auth-lifecycle.ts");

    expect(pluginSource).toContain(
      'firstArgument?.type === "MemberExpression"',
    );
    expect(pluginSource).toContain("isIdentifier(firstArgument.property)");
    expect(pluginSource).toContain("return firstArgument.property.name");
  });
});

describe("self-host auth bootstrap lifecycle", () => {
  test("bootstrap enrollment is the only first-user auth path", () => {
    const authSource = readSecurityFixture("../../lib/auth.ts");
    const selfhostAuthSource = readSecurityFixture(
      "../../lib/selfhost-auth.ts",
    );

    expect(authSource).toContain("emailAndPassword");
    expect(authSource).toContain('"/sign-in/email": AUTH_RATE_LIMITS.signIn');
    expect(authSource).toContain("isSelfhostLocalPasswordAuthEnabled()");
    expect(authSource).toContain("assertSelfhostBootstrapSignUp(ctx.body)");
    expect(authSource).toContain("assertSelfhostEmailOtpAllowed(ctx.path)");
    expect(authSource).toContain("NEW_SESSION_SECURITY_PATHS");
    expect(authSource).toContain("SIGN_IN_EMAIL_PATH");
    expect(authSource).toContain("isTransactionalEmailConfigured()");
    expect(selfhostAuthSource).toContain('"/sign-up/email"');
    expect(selfhostAuthSource).toContain("SELFHOST_BOOTSTRAP_TOKEN");
    expect(selfhostAuthSource).toContain("hasAnyAuthUsers()");
    expect(selfhostAuthSource).toContain("timingSafeEqual");
  });

  test("bootstrap token comparison matches only the configured token", () => {
    expect(
      isBootstrapTokenMatch({
        candidate: "railway-bootstrap-token",
        expected: "railway-bootstrap-token",
      }),
    ).toBe(true);
    expect(
      isBootstrapTokenMatch({
        candidate: "railway-bootstrap-token",
        expected: "different-bootstrap-token",
      }),
    ).toBe(false);
  });

  test("password bootstrap has a database-level singleton guard", () => {
    const authSchemaSource = readSecurityFixture("../../db/auth-schema.ts");
    const migrationSource = readRootFixture(
      "apps/api/drizzle/20260703233000_account_credential_singleton/migration.sql",
    );

    expect(authSchemaSource).toContain("account_credential_singleton_uidx");
    expect(authSchemaSource).toContain("'credential'");
    expect(migrationSource).toContain("account_credential_singleton_uidx");
    expect(migrationSource).toContain("WHERE provider_id = 'credential'");
  });
});
