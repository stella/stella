import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  createOrganizationOidcProvider,
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
  launchUrlFor: (providerId: string) =>
    `https://app.example.com/auth?sso=${providerId}`,
};

const clock = createTestClock("2026-11-23T12:00:00.000Z");
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
    createdAt: clock.now(),
  });
  return brandPersistedOrganizationId(id);
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
    createdAt: clock.now(),
  });
};

describe("sso-management", () => {
  test("manages OIDC providers, enforces policy invariants, and strips clientSecret on read", async () => {
    const adminId = await insertUser(`${unique("admin")}@acme.example.com`);
    const orgId = await insertOrg("Acme");
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

    // Create OIDC provider.
    const created = await createOrganizationOidcProvider(testDb, {
      organizationId: orgId,
      userId: adminId,
      displayName: "Okta Prod",
      issuer: "https://acme.okta.com",
      clientId: "okta-client-1",
      clientSecret: "super-secret-value",
      domains: ["acme.example.com"],
      urls,
    });
    expect(created.isOk()).toBe(true);
    if (!created.isOk()) {
      return;
    }

    expect(created.value.providerId).toMatch(/^sso_okta-prod_/u);
    expect(created.value.hasClientSecret).toBe(true);
    expect(JSON.stringify(created.value)).not.toContain("super-secret-value");

    // Now policy can be switched to required.
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

    const provA = await createOrganizationOidcProvider(testDb, {
      organizationId: orgA,
      userId: adminA,
      displayName: "Entra A",
      issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
      clientId: "cid-a",
      clientSecret: "csec-a",
      domains: [domain],
      urls,
    });
    expect(provA.isOk()).toBe(true);
    if (!provA.isOk()) {
      return;
    }

    // Unverified domain is NOT discoverable by email domain.
    const domA = await createOrganizationSsoDomain(testDb, {
      organizationId: orgA,
      domain,
      createdBy: adminA,
    });
    expect(domA.isOk()).toBe(true);
    if (!domA.isOk()) {
      return;
    }
    expect(await discoverVerifiedSsoProvidersByDomain(testDb, domain)).toEqual(
      [],
    );

    // Once verified, email-domain discovery returns orgA's provider.
    const verifiedA = await recordOrganizationSsoDomainCheck(testDb, {
      organizationId: orgA,
      domainId: domA.value.id,
      verified: true,
      checkedAt: clock.now(),
    });
    expect(verifiedA.isOk()).toBe(true);
    const discovered = await discoverVerifiedSsoProvidersByDomain(
      testDb,
      domain,
    );
    expect(discovered).toEqual([
      {
        providerId: provA.value.providerId,
        displayName: "Entra A",
        protocol: "oidc",
      },
    ]);

    // Direct lookup by providerId also resolves.
    const byId = await discoverSsoProviderById(testDb, provA.value.providerId);
    expect(byId).toHaveLength(1);

    // Org B cannot claim the same verified domain.
    const domB = await createOrganizationSsoDomain(testDb, {
      organizationId: orgB,
      domain,
      createdBy: adminB,
    });
    expect(domB.isOk()).toBe(true);
    if (!domB.isOk()) {
      return;
    }
    const hijack = await recordOrganizationSsoDomainCheck(testDb, {
      organizationId: orgB,
      domainId: domB.value.id,
      verified: true,
      checkedAt: clock.now(),
    });
    expect(hijack.isErr()).toBe(true);
    if (hijack.isErr()) {
      expect(hijack.error.reason).toBe("domain_verified_elsewhere");
    }

    // Cleanup domain works.
    const removed = await deleteOrganizationSsoDomain(testDb, {
      organizationId: orgA,
      domainId: domA.value.id,
    });
    expect(removed.isOk()).toBe(true);
    expect(await discoverVerifiedSsoProvidersByDomain(testDb, domain)).toEqual(
      [],
    );
  });
});
