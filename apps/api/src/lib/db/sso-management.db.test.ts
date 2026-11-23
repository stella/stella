import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestClock } from "@stll/test-kit";

import { account, member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import {
  createOrganizationOidcProvider,
  createOrganizationSamlProvider,
  createOrganizationSsoDomain,
  deleteOrganizationSsoDomain,
  deleteOrganizationSsoProvider,
  discoverSsoProviderById,
  discoverVerifiedSsoProvidersByDomain,
  listOrganizationSsoProvidersForMember,
  readOrganizationSsoSettings,
  recordOrganizationSsoDomainCheck,
  updateOrganizationSsoRequirement,
} from "@/api/lib/db/sso-management";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const urls = {
  callbackUrlFor: (providerId: string) =>
    `https://app.example.com/api/auth/sso/callback/${providerId}`,
  acsUrlFor: (providerId: string) =>
    `https://app.example.com/api/auth/sso/saml2/callback/${providerId}`,
  spMetadataUrlFor: (providerId: string) =>
    `https://app.example.com/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`,
  launchUrlFor: (providerId: string) =>
    `https://app.example.com/auth?sso=${providerId}`,
};

const clock = createTestClock({
  start: Date.parse("2026-11-23T12:00:00.000Z"),
});
const unique = (prefix: string) =>
  `${prefix}-${Bun.randomUUIDv7().replaceAll("-", "").slice(-10)}`;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const insertUser = async (email: string) => {
  const id = unique("user");
  await testDb.insert(user).values({
    id,
    name: "Test Admin",
    email,
    emailVerified: true,
  });
  return brandPersistedUserId(id);
};

const insertOrg = async (name: string) => {
  const id = unique("org");
  await testDb.insert(organization).values({
    id,
    name,
    slug: id,
    createdAt: new Date(clock.now()),
  });
  const orgId = brandPersistedOrganizationId(id);
  await testDb.insert(organizationAccessStates).values({
    organizationId: orgId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  return orgId;
};

const insertMember = async (
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "owner",
) => {
  await testDb.insert(member).values({
    id: unique("mem"),
    organizationId,
    userId,
    role,
    createdAt: new Date(clock.now()),
  });
};

describe("sso-management", () => {
  test("manages OIDC providers, enforces domain verification and policy invariants, and strips clientSecret on read", async () => {
    const adminId = await insertUser(
      `${unique("admin")}@northwind.example.com`,
    );
    const orgId = await insertOrg("Northwind");
    await insertMember(orgId, adminId, "owner");

    // Cannot require SSO before configuring a provider.
    const requireBeforeProvider = await updateOrganizationSsoRequirement(
      testDb,
      { organizationId: orgId, requirement: "required" },
    );
    expect(requireBeforeProvider.isErr()).toBe(true);
    if (requireBeforeProvider.isErr()) {
      expect(requireBeforeProvider.error.reason).toBe(
        "provider_required_to_enforce",
      );
    }

    // Unverified domains are rejected before persisting a provider.
    const rejectedUnverified = await createOrganizationOidcProvider(testDb, {
      organizationId: orgId,
      userId: adminId,
      displayName: "Okta Unverified",
      issuer: "https://northwind.okta.com",
      clientId: "okta-client-1",
      clientSecret: "super-secret-value",
      domains: ["northwind.example.com"],
      urls,
    });
    expect(rejectedUnverified.isErr()).toBe(true);

    // Verify domain ownership via DNS TXT claim first.
    const claim = await createOrganizationSsoDomain(testDb, {
      organizationId: orgId,
      createdBy: adminId,
      domain: "northwind.example.com",
    });
    expect(claim.isOk()).toBe(true);
    if (claim.isOk()) {
      const checked = await recordOrganizationSsoDomainCheck(testDb, {
        organizationId: orgId,
        domainId: claim.value.id,
        verified: true,
        checkedAt: new Date(clock.now()),
      });
      expect(checked.isOk()).toBe(true);
    }

    // Now creating the OIDC provider succeeds.
    const created = await createOrganizationOidcProvider(testDb, {
      organizationId: orgId,
      userId: adminId,
      displayName: "Okta Prod",
      issuer: "https://northwind.okta.com",
      clientId: "okta-client-1",
      clientSecret: "super-secret-value",
      domains: ["northwind.example.com"],
      urls,
    });
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) {
      return;
    }

    expect(created.value.providerId).toMatch(/^sso_okta-prod_/u);
    expect(created.value.hasClientSecret).toBe(true);
    expect(JSON.stringify(created.value)).not.toContain("super-secret-value");

    // Cannot require SSO while an existing member has no bound SSO account.
    const blockedUnbound = await updateOrganizationSsoRequirement(testDb, {
      organizationId: orgId,
      requirement: "required",
    });
    expect(blockedUnbound.isErr()).toBe(true);

    // Bind the existing member to the SSO provider -> now required succeeds.
    await testDb.insert(account).values({
      id: unique("acct"),
      accountId: `sub-${adminId}`,
      providerId: created.value.providerId,
      userId: adminId,
      ssoProviderId: created.value.id,
      createdAt: new Date(clock.now()),
      updatedAt: new Date(clock.now()),
    });

    const required = await updateOrganizationSsoRequirement(testDb, {
      organizationId: orgId,
      requirement: "required",
    });
    expect(required.isOk()).toBe(true);

    // Deleting the last provider while required is refused.
    const deleteWhileRequired = await deleteOrganizationSsoProvider(testDb, {
      organizationId: orgId,
      providerId: created.value.providerId,
    });
    expect(deleteWhileRequired.isErr()).toBe(true);
    if (deleteWhileRequired.isErr()) {
      expect(deleteWhileRequired.error.reason).toBe(
        "last_provider_while_required",
      );
    }

    // Read settings returns masked summary and member listing works only for members.
    const settings = await readOrganizationSsoSettings(testDb, orgId, urls);
    expect(settings.requirement).toBe("required");
    expect(settings.providers).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain("super-secret-value");

    const memberProviders = await listOrganizationSsoProvidersForMember(
      testDb,
      { organizationId: orgId, userId: adminId },
    );
    expect(memberProviders).toHaveLength(1);

    const outsiderId = await insertUser(`${unique("out")}@other.example.com`);
    const outsiderProviders = await listOrganizationSsoProvidersForMember(
      testDb,
      { organizationId: orgId, userId: outsiderId },
    );
    expect(outsiderProviders).toEqual([]);

    // Switch back to optional and delete.
    await updateOrganizationSsoRequirement(testDb, {
      organizationId: orgId,
      requirement: "optional",
    });
    const deleted = await deleteOrganizationSsoProvider(testDb, {
      organizationId: orgId,
      providerId: created.value.providerId,
    });
    expect(deleted.isOk()).toBe(true);
  });

  test("only discovers verified domains and prevents cross-org domain hijacking", async () => {
    const adminA = await insertUser(`${unique("a")}@firm-a.example.com`);
    const adminB = await insertUser(`${unique("b")}@firm-b.example.com`);
    const orgA = await insertOrg("Firm A");
    const orgB = await insertOrg("Firm B");
    const domain = `${unique("corp")}.example.com`;

    // Domain is pending -> not discoverable and cannot be bound yet.
    const claimA = await createOrganizationSsoDomain(testDb, {
      organizationId: orgA,
      createdBy: adminA,
      domain,
    });
    expect(claimA.isOk()).toBe(true);
    if (!claimA.isOk()) {
      return;
    }
    expect(await discoverVerifiedSsoProvidersByDomain(testDb, domain)).toEqual(
      [],
    );

    // Verify domain for org A -> now provider can bind it and discovery returns it.
    const verifiedA = await recordOrganizationSsoDomainCheck(testDb, {
      organizationId: orgA,
      domainId: claimA.value.id,
      verified: true,
      checkedAt: new Date(clock.now()),
    });
    expect(verifiedA.isOk()).toBe(true);

    const provA = await createOrganizationOidcProvider(testDb, {
      organizationId: orgA,
      userId: adminA,
      displayName: "Firm A Entra",
      issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
      clientId: "entra-client-a",
      clientSecret: "entra-secret-a",
      domains: [domain],
      urls,
    });
    expect(provA.isOk()).toBe(true);
    if (!provA.isOk()) {
      return;
    }

    const discovered = await discoverVerifiedSsoProvidersByDomain(
      testDb,
      domain,
    );
    expect(discovered).toHaveLength(1);
    expect(discovered.at(0)?.providerId).toBe(provA.value.providerId);

    const byId = await discoverSsoProviderById(testDb, provA.value.providerId);
    expect(byId.at(0)?.providerId).toBe(provA.value.providerId);

    // Org B cannot verify/hijack a domain already verified by Org A.
    const claimB = await createOrganizationSsoDomain(testDb, {
      organizationId: orgB,
      createdBy: adminB,
      domain,
    });
    expect(claimB.isOk()).toBe(true);
    if (claimB.isOk()) {
      const hijack = await recordOrganizationSsoDomainCheck(testDb, {
        organizationId: orgB,
        domainId: claimB.value.id,
        verified: true,
        checkedAt: new Date(clock.now()),
      });
      expect(hijack.isErr()).toBe(true);
      if (hijack.isErr()) {
        expect(hijack.error.reason).toBe("domain_verified_elsewhere");
      }
    }

    // Deleting domain removes it from discovery.
    const removed = await deleteOrganizationSsoDomain(testDb, {
      organizationId: orgA,
      domainId: claimA.value.id,
    });
    expect(removed.isOk()).toBe(true);
    expect(await discoverVerifiedSsoProvidersByDomain(testDb, domain)).toEqual(
      [],
    );
  });

  test("creates and discovers hardened SAML 2.0 providers with verified domains, ACS, and SP metadata URLs", async () => {
    const adminId = await insertUser(`${unique("saml")}@saml.example.com`);
    const orgId = await insertOrg("SAML Org");
    const domain = `${unique("saml-dom")}.example.com`;
    const sampleCert =
      "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END CERTIFICATE-----";

    // Unverified domain is rejected for SAML too.
    const unverified = await createOrganizationSamlProvider(testDb, {
      organizationId: orgId,
      userId: adminId,
      displayName: "Okta SAML Unverified",
      issuer: "https://idp.saml.example.com/entity",
      entryPoint: "https://idp.saml.example.com/sso/saml",
      cert: sampleCert,
      domains: [domain],
      urls,
    });
    expect(unverified.isErr()).toBe(true);

    const claim = await createOrganizationSsoDomain(testDb, {
      organizationId: orgId,
      createdBy: adminId,
      domain,
    });
    expect(claim.isOk()).toBe(true);
    if (claim.isOk()) {
      await recordOrganizationSsoDomainCheck(testDb, {
        organizationId: orgId,
        domainId: claim.value.id,
        verified: true,
        checkedAt: new Date(clock.now()),
      });
    }

    const created = await createOrganizationSamlProvider(testDb, {
      organizationId: orgId,
      userId: adminId,
      displayName: "Okta SAML",
      issuer: "https://idp.saml.example.com/entity",
      entryPoint: "https://idp.saml.example.com/sso/saml",
      cert: sampleCert,
      domains: [domain],
      urls,
    });
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) {
      return;
    }
    expect(created.value.protocol).toBe("saml");
    expect(created.value.acsUrl).toContain("/api/auth/sso/saml2/callback/");
    expect(created.value.spMetadataUrl).toContain(
      "/api/auth/sso/saml2/sp/metadata",
    );

    const discovered = await discoverVerifiedSsoProvidersByDomain(
      testDb,
      domain,
    );
    expect(discovered).toHaveLength(1);
    expect(discovered.at(0)?.protocol).toBe("saml");
  });
});
