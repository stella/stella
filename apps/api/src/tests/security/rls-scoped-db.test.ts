import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  entities,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createScopedDb,
} from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const ownerPersonalWorkspaceId = createSafeId<"workspace">();
const otherPersonalWorkspaceId = createSafeId<"workspace">();
const scopedAuthorizationLifetimeWorkspaceId = createSafeId<"workspace">();
const safeAuthorizationLifetimeWorkspaceId = createSafeId<"workspace">();

const setupRlsScopedDb = async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.insert(workspaces).values([
    {
      id: ownerPersonalWorkspaceId,
      organizationId: ids.orgA,
      clientId: null,
      name: "Owner personal workspace",
      reference: `PERSONAL-${ownerPersonalWorkspaceId}`,
    },
    {
      id: otherPersonalWorkspaceId,
      organizationId: ids.orgA,
      clientId: null,
      name: "Other personal workspace",
      reference: `PERSONAL-${otherPersonalWorkspaceId}`,
    },
    {
      id: scopedAuthorizationLifetimeWorkspaceId,
      organizationId: ids.orgA,
      clientId: null,
      leadUserId: ids.userA2,
      name: "Scoped authorization lifetime workspace",
      reference: `SCOPED-LIFETIME-${scopedAuthorizationLifetimeWorkspaceId}`,
    },
    {
      id: safeAuthorizationLifetimeWorkspaceId,
      organizationId: ids.orgA,
      clientId: null,
      leadUserId: ids.userA2,
      name: "Safe authorization lifetime workspace",
      reference: `SAFE-LIFETIME-${safeAuthorizationLifetimeWorkspaceId}`,
    },
  ]);
  await testDb.insert(workspaceMembers).values([
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: ownerPersonalWorkspaceId,
      userId: ids.userAdmin,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: scopedAuthorizationLifetimeWorkspaceId,
      userId: ids.userA1,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: scopedAuthorizationLifetimeWorkspaceId,
      userId: ids.userA2,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: safeAuthorizationLifetimeWorkspaceId,
      userId: ids.userA1,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: safeAuthorizationLifetimeWorkspaceId,
      userId: ids.userA2,
    },
  ]);
};

beforeAll(setupRlsScopedDb, { timeout: 30_000 });

afterAll(async () => {
  await releaseRlsFixture();
});

// ════════════════════════════════════════════════════════
// createScopedDb integration
// ════════════════════════════════════════════════════════

describe("createScopedDb", () => {
  test("scoped to wsA1 → only wsA1 entities", async () => {
    const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const rows = await scoped((tx) =>
      tx.select({ id: entities.id }).from(entities),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ids.entityA1);
  });

  test("scoped to wsA1 + wsA2 → both entities", async () => {
    const scoped = createScopedDb(
      testDb,
      [ids.wsA1, ids.wsA2],
      ids.orgA,
      ids.userA1,
    );
    const rows = await scoped((tx) =>
      tx.select({ id: entities.id }).from(entities).orderBy(entities.id),
    );
    expect(rows).toHaveLength(2);
  });

  test("scoped to [] → zero rows", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const c = await scoped((tx) => tx.$count(entities));
    expect(c).toBe(0);
  });

  test("scoped to wsB1 with orgA → sees wsB1 entities (ws policy only)", async () => {
    // Documents this behavior: ws policy checks wsIds,
    // not org. Safe because wsIds are server-set.
    const scoped = createScopedDb(testDb, [ids.wsB1], ids.orgA, ids.userA1);
    const c = await scoped((tx) => tx.$count(entities));
    expect(c).toBeGreaterThan(0);
  });

  test("nested queries in same tx respect RLS", async () => {
    const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const result = await scoped(async (tx) => {
      const [e, p, f] = await Promise.all([
        tx.$count(entities),
        tx.$count(properties),
        tx.$count(fields),
      ]);
      return { entities: e, props: p, fields: f };
    });
    expect(result.entities).toBe(1);
    // properties has 2 in wsA1 (propertyA1 + propertyA1dep)
    expect(result.props).toBe(2);
    expect(result.fields).toBe(1);
  });
});

describe("createMembershipScopedDb", () => {
  test("derives a regular member's workspace scope from scalar identity settings", async () => {
    const scoped = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userA2,
    });
    const rows = await scoped((tx) =>
      tx.select({ workspaceId: entities.workspaceId }).from(entities),
    );

    expect(rows.map((row) => row.workspaceId)).toEqual([ids.wsA2]);
  });

  test("owner bypass reaches client matters only inside the active organization", async () => {
    const scoped = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    });
    const rows = await scoped((tx) =>
      tx
        .select({ workspaceId: entities.workspaceId })
        .from(entities)
        .orderBy(entities.workspaceId),
    );

    expect(rows.map((row) => row.workspaceId).sort()).toEqual(
      [ids.wsA1, ids.wsA2].sort(),
    );
  });

  test("owner bypass does not expose another user's personal workspace", async () => {
    const scoped = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    });
    const rows = await scoped((tx) =>
      tx.select({ id: workspaces.id }).from(workspaces),
    );
    const visibleIds = rows.map((row) => row.id);

    expect(visibleIds).toContain(ownerPersonalWorkspaceId);
    expect(visibleIds).not.toContain(otherPersonalWorkspaceId);
  });

  test("keeps a server-validated workspace authorized after self-removal", async () => {
    const scoped = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [scopedAuthorizationLifetimeWorkspaceId],
      userId: ids.userA2,
    });

    const result = await scoped(async (tx) => {
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(
              workspaceMembers.workspaceId,
              scopedAuthorizationLifetimeWorkspaceId,
            ),
            eq(workspaceMembers.userId, ids.userA2),
          ),
        );

      const updated = await tx
        .update(workspaces)
        .set({ leadUserId: null })
        .where(eq(workspaces.id, scopedAuthorizationLifetimeWorkspaceId))
        .returning({ id: workspaces.id });
      const crossOrganizationRows = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, ids.wsB1));

      return { crossOrganizationRows, updated };
    });

    expect(result.updated).toEqual([
      { id: scopedAuthorizationLifetimeWorkspaceId },
    ]);
    expect(result.crossOrganizationRows).toEqual([]);
  });

  test("safe membership scope keeps the bounded authorization snapshot", async () => {
    const serverValidatedWorkspaceIds: SafeId<"workspace">[] = [];
    const safeDb = createMembershipSafeDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds,
      userId: ids.userA2,
    });

    const accessResult = await safeDb((tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, safeAuthorizationLifetimeWorkspaceId)),
    );
    expect(Result.isOk(accessResult)).toBe(true);
    if (Result.isOk(accessResult)) {
      expect(accessResult.value).toEqual([
        { id: safeAuthorizationLifetimeWorkspaceId },
      ]);
    }

    // Mirrors getWorkspaceAccess: mutate the same bounded array only after
    // the membership-scoped query has proved access. The factory must retain
    // that authorization for later transactions.
    serverValidatedWorkspaceIds.push(safeAuthorizationLifetimeWorkspaceId);
    const result = await safeDb(async (tx) => {
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(
              workspaceMembers.workspaceId,
              safeAuthorizationLifetimeWorkspaceId,
            ),
            eq(workspaceMembers.userId, ids.userA2),
          ),
        );

      return await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, safeAuthorizationLifetimeWorkspaceId));
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual([
        { id: safeAuthorizationLifetimeWorkspaceId },
      ]);
    }
  });
});
