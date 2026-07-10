import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  entities,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipScopedDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
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

beforeAll(async () => {
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
  ]);
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId: ownerPersonalWorkspaceId,
    userId: ids.userAdmin,
  });
});

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
      userId: ids.userAdmin,
    });
    const rows = await scoped((tx) =>
      tx.select({ id: workspaces.id }).from(workspaces),
    );
    const visibleIds = rows.map((row) => row.id);

    expect(visibleIds).toContain(ownerPersonalWorkspaceId);
    expect(visibleIds).not.toContain(otherPersonalWorkspaceId);
  });
});
