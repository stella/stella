import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  agentSkills,
  auditLogs,
  documentTypes,
  organizationAccessStates,
} from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createReviewAccountOrganizationStore } from "@/api/lib/auth/review-account-organization-store";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import {
  bindReviewAccountOrganizationStore,
  provisionReviewAccount,
} from "@/api/scripts/review-account.logic";
import type { ReviewAccountStore } from "@/api/scripts/review-account.logic";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

/** The command's store over the test database: accounts as plain rows. */
const createStore = (): ReviewAccountStore => ({
  ...bindReviewAccountOrganizationStore(
    // The PGlite database stands in for the owner connection db/root.ts binds.
    createReviewAccountOrganizationStore(
      asTestRaw<Parameters<typeof createReviewAccountOrganizationStore>[0]>(
        testDb,
      ),
    ),
  ),
  findUserIdByEmail: async (email) =>
    (
      await testDb
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
    ).at(0)?.id ?? null,
  hasTwoFactorEnabled: async (userId) =>
    (
      await testDb
        .select({ enabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, userId))
    ).at(0)?.enabled === true,
  createUser: async (email) => {
    const id = mintAuthProviderIdValue();
    await testDb.insert(user).values({
      id,
      email,
      name: "Reviewer",
      emailVerified: true,
    });
    return id;
  },
  setPassword: async () => undefined,
  revokeSessions: async () => 0,
  revokeVerifications: async () => 0,
});

describe("review account provisioning store", () => {
  test("creates the account's organization and owner once, with audit events", async () => {
    const organizationId = mintAuthProviderIdValue();
    const config = {
      email: `review-${organizationId.toLowerCase()}@example.test`,
      organizationId,
    };
    const store = createStore();

    const first = await provisionReviewAccount({
      config,
      demoEmail: undefined,
      store,
    });
    expect(first).toEqual(
      Result.ok({
        outcome: "provisioned",
        user: "created",
        organization: "created",
        membership: "created",
      }),
    );

    const snapshot = async () => {
      const branded = brandPersistedOrganizationId(organizationId);
      return {
        organizations: await testDb
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(eq(organization.id, organizationId)),
        members: await testDb
          .select({ role: member.role, userId: member.userId })
          .from(member)
          .where(eq(member.organizationId, organizationId)),
        accessStates: (
          await testDb
            .select({ id: organizationAccessStates.organizationId })
            .from(organizationAccessStates)
            .where(eq(organizationAccessStates.organizationId, branded))
        ).length,
        documentTypes: (
          await testDb
            .select({ key: documentTypes.key })
            .from(documentTypes)
            .where(eq(documentTypes.organizationId, branded))
        ).length,
        skills: (
          await testDb
            .select({ id: agentSkills.id })
            .from(agentSkills)
            .where(eq(agentSkills.organizationId, branded))
        ).length,
        audit: (
          await testDb
            .select({
              action: auditLogs.action,
              resourceType: auditLogs.resourceType,
              metadata: auditLogs.metadata,
            })
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, branded))
        )
          // The seeded default skills record their own creation events.
          .filter(
            (row) =>
              row.resourceType === AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          )
          .map((row) => `${row.action}:${String(row.metadata?.["cause"])}`)
          .toSorted(),
        auditTotal: (
          await testDb
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, branded))
        ).length,
      };
    };

    const created = await snapshot();
    const ownerId = await store.findUserIdByEmail(config.email);
    expect(created.organizations).toEqual([
      { id: organizationId, name: "Sample law firm" },
    ]);
    expect(created.members).toEqual([{ role: "owner", userId: ownerId ?? "" }]);
    expect(created.accessStates).toBe(1);
    expect(created.documentTypes).toBeGreaterThan(0);
    expect(created.skills).toBeGreaterThan(0);
    expect(created.audit).toEqual([
      "create:review_account_organization_created",
      "update:review_account_owner_added",
    ]);

    const second = await provisionReviewAccount({
      config,
      demoEmail: undefined,
      store,
    });
    expect(second).toEqual(
      Result.ok({
        outcome: "provisioned",
        user: "existing",
        organization: "existing",
        membership: "existing",
      }),
    );
    expect(await snapshot()).toEqual(created);
  });

  test("refuses an enrolled account and one that belongs elsewhere, writing nothing", async () => {
    const store = createStore();
    for (const shape of ["two-factor", "other-organization"] as const) {
      const organizationId = mintAuthProviderIdValue();
      const email = `review-${organizationId.toLowerCase()}@example.test`;
      const userId = await store.createUser(email);
      if (shape === "two-factor") {
        await testDb
          .update(user)
          .set({ twoFactorEnabled: true })
          .where(eq(user.id, userId));
      } else {
        await store.createOrganization({
          organizationId: mintAuthProviderIdValue(),
          ownerUserId: userId,
        });
      }
      const result = await provisionReviewAccount({
        config: { email, organizationId },
        demoEmail: undefined,
        store,
      });
      expect(Result.isError(result) && result.error.code).toBe(
        shape === "two-factor"
          ? "two-factor-enabled"
          : "account-in-other-organization",
      );
      expect(await store.organizationExists(organizationId)).toBe(false);
    }
  });
});
