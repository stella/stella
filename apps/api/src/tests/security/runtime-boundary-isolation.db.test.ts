import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  member,
  organization,
  session as authSession,
  user,
} from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  searchDocumentPreviewPassages,
  searchDocuments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  attenuateScopedDb,
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
} from "@/api/db/scoped";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { createCopyToWorkspace } from "@/api/handlers/entities/copy";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { resolveWorkspaceRealtimeAudience } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import type { IndexEntityDependencies } from "@/api/lib/search/index-entity";
import { searchGlobal } from "@/api/lib/search/index-global";
import { readSearchPreview } from "@/api/lib/search/preview";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
const createdOrgIds: SafeId<"organization">[] = [];
const createdUserIds: SafeId<"user">[] = [];

const projectionDatabase = (): NonNullable<
  IndexEntityDependencies["database"]
> =>
  asTestRaw<NonNullable<IndexEntityDependencies["database"]>>({
    query: testDb.query,
    select: testDb.select.bind(testDb),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      await testDb.transaction(
        async (tx) =>
          await run({
            execute: async (query: SQL) => (await tx.execute(query)).rows,
          }),
      ),
  });

const noAudit = async () => undefined;

const seedUser = async (name: string): Promise<SafeId<"user">> => {
  const id = mintAuthProviderId<"user">();
  createdUserIds.push(id);
  await testDb.insert(user).values({
    id,
    name,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  return id;
};

const seedOrganization = async (
  name: string,
): Promise<SafeId<"organization">> => {
  const id = mintAuthProviderId<"organization">();
  createdOrgIds.push(id);
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  await testDb.insert(organization).values({
    id,
    name,
    slug: `runtime-boundary-${id}`,
    createdAt,
  });
  await recordNewOrganizationAccessState(testDb, {
    organizationId: id,
    now: createdAt,
  });
  return id;
};

const seedOrgMember = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
  role: "member" | "owner",
): Promise<void> => {
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
};

const seedMatter = async (
  organizationId: SafeId<"organization">,
  name: string,
): Promise<SafeId<"workspace">> => {
  const id = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id,
    organizationId,
    name,
    reference: `RB-${id}`,
    status: "active",
  });
  return id;
};

const assignToMatter = async (
  workspaceId: SafeId<"workspace">,
  userId: SafeId<"user">,
): Promise<void> => {
  await testDb.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
};

beforeAll(async () => {
  testDb = await getTestDb();
  const existingConfig = await testDb.execute(
    sql`SELECT 1 FROM pg_ts_config WHERE cfgname = 'stella_unaccent'`,
  );
  if (existingConfig.rows.length === 0) {
    await testDb.execute(
      sql`CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)`,
    );
  }
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await deleteOrganizationsForTest(testDb, createdOrgIds);
  }
  if (createdUserIds.length > 0) {
    await testDb.delete(user).where(inArray(user.id, createdUserIds));
  }
  await releaseTestDb();
});

describe("runtime boundary isolation", () => {
  test("narrowed chat-to-MCP context blocks out-of-scope matters at the RLS database layer", async () => {
    const organizationId = await seedOrganization("Chat Scope Org");
    const actorId = await seedUser("Pinned Chat Member");
    await seedOrgMember(organizationId, actorId, "member");

    const matterA = await seedMatter(organizationId, "Matter A (Pinned)");
    const matterB = await seedMatter(organizationId, "Matter B (Excluded)");
    await assignToMatter(matterA, actorId);
    await assignToMatter(matterB, actorId);

    const entityA = createSafeId<"entity">();
    const entityB = createSafeId<"entity">();
    await testDb.insert(entities).values([
      {
        id: entityA,
        workspaceId: matterA,
        kind: "document",
        name: "In-scope Memo A",
      },
      {
        id: entityB,
        workspaceId: matterB,
        kind: "document",
        name: "Out-of-scope Memo B",
      },
    ]);

    const membershipIdentity = {
      organizationId,
      serverValidatedWorkspaceIds: [] as SafeId<"workspace">[],
      userId: actorId,
    };
    const membershipScopedDb = asTestRaw<ScopedDb>(
      createMembershipScopedDb(testDb, membershipIdentity),
    );
    const membershipSafeDb = asTestRaw<SafeDb>(
      createMembershipSafeDb(testDb, membershipIdentity),
    );

    // Baseline: un-narrowed membership scope can read both matters.
    const baselineEntityIds = await membershipScopedDb(async (tx) =>
      (await tx.select({ id: entities.id }).from(entities)).map(
        (row) => row.id,
      ),
    );
    expect(baselineEntityIds.toSorted()).toEqual([entityA, entityB].toSorted());

    const narrowedContext = buildMcpContextFromChat({
      organizationId,
      userId: actorId,
      userEmail: `${actorId}@example.test`,
      memberRole: sessionMemberRole("member"),
      pinServerValidatedWorkspaceId: () => true,
      safeDb: membershipSafeDb,
      scopedDb: membershipScopedDb,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [matterA],
        accessibleWorkspaceIds: [matterA, matterB],
      }),
      workspaceStatusById: new Map([
        [matterA, "active" as const],
        [matterB, "active" as const],
      ]),
    });

    // Forbidden probe + authorized control via scopedDb: only Matter A is visible.
    const scopedEntityIds = await narrowedContext.scopedDb(async (tx) =>
      (await tx.select({ id: entities.id }).from(entities)).map(
        (row) => row.id,
      ),
    );
    expect(scopedEntityIds).toEqual([entityA]);
    expect(scopedEntityIds).not.toContain(entityB);

    const scopedWorkspaceIds = await narrowedContext.scopedDb(async (tx) =>
      (await tx.select({ id: workspaces.id }).from(workspaces)).map(
        (row) => row.id,
      ),
    );
    expect(scopedWorkspaceIds).toEqual([matterA]);
    expect(scopedWorkspaceIds).not.toContain(matterB);

    // Forbidden probe + authorized control via safeDb: only Matter A is visible.
    const safeEntityIdsResult = await narrowedContext.safeDb(async (tx) =>
      (await tx.select({ id: entities.id }).from(entities)).map(
        (row) => row.id,
      ),
    );
    expect(Result.isOk(safeEntityIdsResult)).toBe(true);
    if (Result.isOk(safeEntityIdsResult)) {
      expect(safeEntityIdsResult.value).toEqual([entityA]);
      expect(safeEntityIdsResult.value).not.toContain(entityB);
    }

    // Workspace pin gate stays aligned with the narrowed boundary.
    expect(narrowedContext.pinServerValidatedWorkspaceId?.(matterA)).toBe(true);
    expect(narrowedContext.pinServerValidatedWorkspaceId?.(matterB)).toBe(
      false,
    );

    // Re-attenuating an already explicit handle cannot widen back to Matter B.
    const reAttenuatedScopedDb = attenuateScopedDb(narrowedContext.scopedDb, [
      matterA,
      matterB,
    ]);
    const reAttenuatedEntityIds = await reAttenuatedScopedDb(async (tx) =>
      (await tx.select({ id: entities.id }).from(entities)).map(
        (row) => row.id,
      ),
    );
    expect(reAttenuatedEntityIds).toEqual([entityA]);
    expect(reAttenuatedEntityIds).not.toContain(entityB);
  });

  test("moving an entity across matters moves search and preview projections out of the source matter", async () => {
    const organizationId = await seedOrganization("Entity Move Projection Org");
    const moverId = await seedUser("Cross-Matter Mover");
    const memberAId = await seedUser("Matter A Only Member");
    const memberBId = await seedUser("Matter B Only Member");

    await seedOrgMember(organizationId, moverId, "owner");
    await seedOrgMember(organizationId, memberAId, "member");
    await seedOrgMember(organizationId, memberBId, "member");

    const matterA = await seedMatter(organizationId, "Source Matter A");
    const matterB = await seedMatter(organizationId, "Destination Matter B");

    await assignToMatter(matterA, moverId);
    await assignToMatter(matterB, moverId);
    await assignToMatter(matterA, memberAId);
    await assignToMatter(matterB, memberBId);

    const uniqueSecretToken = "zxqtransferclause7741";
    const sourcePropertyId = createSafeId<"property">();
    const sourceEntityId = createSafeId<"entity">();
    const sourceVersionId = createSafeId<"entityVersion">();

    await testDb.insert(properties).values([
      {
        id: sourcePropertyId,
        workspaceId: matterA,
        name: "Summary",
        content: { type: "text", version: 1 },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
        kinds: ["document"],
      },
      {
        id: createSafeId<"property">(),
        workspaceId: matterA,
        name: "File",
        content: { type: "file", version: 1 },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
        system: true,
        kinds: ["document"],
      },
      {
        id: createSafeId<"property">(),
        workspaceId: matterB,
        name: "File",
        content: { type: "file", version: 1 },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
        system: true,
        kinds: ["document"],
      },
    ]);
    await testDb.insert(entities).values({
      id: sourceEntityId,
      workspaceId: matterA,
      kind: "document",
      name: `Confidential Settlement Memo ${uniqueSecretToken}`,
    });
    await testDb.insert(entityVersions).values({
      id: sourceVersionId,
      workspaceId: matterA,
      entityId: sourceEntityId,
    });
    await testDb.insert(fields).values({
      id: createSafeId<"field">(),
      entityVersionId: sourceVersionId,
      workspaceId: matterA,
      propertyId: sourcePropertyId,
      content: {
        type: "text",
        version: 1,
        value: `Confidential covenant ${uniqueSecretToken} for deal closing.`,
      },
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: sourceVersionId })
      .where(eq(entities.id, sourceEntityId));

    // Index via the rootDb projection writer.
    await upsertSearchDocument(sourceEntityId, {
      database: projectionDatabase(),
      syncActivity: async () => undefined,
    });

    const memberScope = (userId: SafeId<"user">): ScopedDb =>
      executeRowsScopedDb(
        createMembershipScopedDb(testDb, {
          organizationId,
          serverValidatedWorkspaceIds: [],
          userId,
        }),
      );

    const memberAScopedDb = memberScope(memberAId);
    const memberBScopedDb = memberScope(memberBId);

    const searchForMember = async (
      userId: SafeId<"user">,
      scopedDb: ScopedDb,
      accessibleWorkspaceIds: readonly SafeId<"workspace">[],
    ) =>
      (
        await searchGlobal(
          {
            query: uniqueSecretToken,
            organizationId,
            userId,
            accessibleWorkspaceIds: [...accessibleWorkspaceIds],
            selectedWorkspaceIds: [],
            types: ["document"],
            grantedScopes: undefined,
            editedByUserIds: [],
            mimeTypes: [],
            limit: 20,
          },
          { scopedDb },
        )
      ).unwrap();

    // Before move: Member A can find & preview the document; Member B cannot.
    const beforeA = await searchForMember(memberAId, memberAScopedDb, [
      matterA,
    ]);
    expect(beforeA.hits.map((hit) => hit.id)).toEqual([
      `entity:${sourceEntityId}`,
    ]);
    const beforePreviewA = (
      await readSearchPreview(
        {
          query: uniqueSecretToken,
          resultId: sourceEntityId,
          type: "document",
          organizationId,
          userId: memberAId,
          accessibleWorkspaceIds: [matterA],
        },
        memberAScopedDb,
      )
    ).unwrap();
    expect(beforePreviewA?.type).toBe("highlighted-html");
    if (beforePreviewA?.type === "highlighted-html") {
      expect(beforePreviewA.content.toLowerCase()).toContain(uniqueSecretToken);
    }

    const beforeB = await searchForMember(memberBId, memberBScopedDb, [
      matterB,
    ]);
    expect(beforeB.hits).toEqual([]);

    // Execute the cross-workspace move handler (deleteSource: true).
    const moveHandler = createCopyToWorkspace({
      copyFileObjects: async () => await Promise.resolve(Result.ok([])),
      enqueueDocumentProcessingRun: async () => undefined,
      enqueueEntitySearchRepairs: async () => undefined,
      enqueueImageThumbnailOrMarkFailed: async () => undefined,
      enqueuePdfDerivativeOrMarkFailed: async () => undefined,
      flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
      requestNativeExtractionRuns: async () => [],
      syncWorkspaceSearchActivity: async () => undefined,
    });
    const moverSafeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [matterA, matterB], organizationId, moverId),
    );
    const moveResult = await moveHandler.handler(
      asTestRaw<Parameters<typeof moveHandler.handler>[0]>({
        workspaceId: matterA,
        user: { id: moverId, email: `${moverId}@example.test` },
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        body: {
          entityId: sourceEntityId,
          targetWorkspaceId: matterB,
          targetParentId: null,
          deleteSource: true,
        },
        request: new Request("https://example.test/move-entity"),
        route:
          "/v1/entities/:workspaceId/copy-to-workspace" satisfies ApiRoutePath,
        safeDb: moverSafeDb,
        recordAuditEvent: noAudit,
        createAuditRecorder: () => noAudit,
        getWorkspaceAccess: async () =>
          await Promise.resolve({
            id: matterB,
            status: "active",
          }),
      }),
    );
    expect(moveResult).toHaveProperty("entityId");

    const movedRows = await testDb
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.workspaceId, matterB));
    const movedEntityId = movedRows.at(0)?.id;
    expect(movedEntityId).toBeDefined();
    if (!movedEntityId) {
      throw new Error("Expected moved entity in destination matter");
    }

    // Run rootDb projection upsert for the moved entity, plus a late/stale
    // projection attempt for the deleted source entity ID.
    await upsertSearchDocument(movedEntityId, {
      database: projectionDatabase(),
      syncActivity: async () => undefined,
    });
    await upsertSearchDocument(sourceEntityId, {
      database: projectionDatabase(),
      syncActivity: async () => undefined,
    });

    // Forbidden probe (Member A — Matter A only): neither search nor preview
    // nor direct RLS projection reads expose the moved document.
    const afterA = await searchForMember(memberAId, memberAScopedDb, [matterA]);
    expect(afterA.hits).toEqual([]);

    const stalePreviewA = (
      await readSearchPreview(
        {
          query: uniqueSecretToken,
          resultId: sourceEntityId,
          type: "document",
          organizationId,
          userId: memberAId,
          accessibleWorkspaceIds: [matterA],
        },
        memberAScopedDb,
      )
    ).unwrap();
    expect(stalePreviewA).toBeNull();

    const movedPreviewProbeA = (
      await readSearchPreview(
        {
          query: uniqueSecretToken,
          resultId: movedEntityId,
          type: "document",
          organizationId,
          userId: memberAId,
          accessibleWorkspaceIds: [matterA],
        },
        memberAScopedDb,
      )
    ).unwrap();
    expect(movedPreviewProbeA).toBeNull();

    const leakedProjectionRowsForA = await memberAScopedDb(async (tx) => {
      const docs = await tx
        .select({ entityId: searchDocuments.entityId })
        .from(searchDocuments)
        .where(
          inArray(searchDocuments.entityId, [sourceEntityId, movedEntityId]),
        );
      const passages = await tx
        .select({ entityId: searchDocumentPreviewPassages.entityId })
        .from(searchDocumentPreviewPassages)
        .where(
          inArray(searchDocumentPreviewPassages.entityId, [
            sourceEntityId,
            movedEntityId,
          ]),
        );
      return { docs, passages };
    });
    expect(leakedProjectionRowsForA).toEqual({ docs: [], passages: [] });

    // Authorized positive control (Member B — Matter B): finds & previews it.
    const afterB = await searchForMember(memberBId, memberBScopedDb, [matterB]);
    expect(afterB.hits.map((hit) => hit.id)).toEqual([
      `entity:${movedEntityId}`,
    ]);

    const afterPreviewB = (
      await readSearchPreview(
        {
          query: uniqueSecretToken,
          resultId: movedEntityId,
          type: "document",
          organizationId,
          userId: memberBId,
          accessibleWorkspaceIds: [matterB],
        },
        memberBScopedDb,
      )
    ).unwrap();
    expect(afterPreviewB?.type).toBe("highlighted-html");
    if (afterPreviewB?.type === "highlighted-html") {
      expect(afterPreviewB.content.toLowerCase()).toContain(uniqueSecretToken);
    }
  });

  test("removing a matter member immediately excludes their session from resolveWorkspaceRealtimeAudience", async () => {
    const organizationId = await seedOrganization("Realtime Audience Org");
    const revokedUserId = await seedUser("Revoked Stream Member");
    const activeUserId = await seedUser("Active Stream Member");

    await seedOrgMember(organizationId, revokedUserId, "member");
    await seedOrgMember(organizationId, activeUserId, "member");

    const matterId = await seedMatter(
      organizationId,
      "Restricted Realtime Matter",
    );
    await assignToMatter(matterId, revokedUserId);
    await assignToMatter(matterId, activeUserId);

    const revokedSessionId = mintAuthProviderIdValue();
    const activeSessionId = mintAuthProviderIdValue();
    const futureExpiry = new Date("2099-01-01T00:00:00.000Z");

    await testDb.insert(authSession).values([
      {
        id: revokedSessionId,
        userId: revokedUserId,
        token: `tok-${revokedSessionId}`,
        activeOrganizationId: organizationId,
        expiresAt: futureExpiry,
      },
      {
        id: activeSessionId,
        userId: activeUserId,
        token: `tok-${activeSessionId}`,
        activeOrganizationId: organizationId,
        expiresAt: futureExpiry,
      },
    ]);

    // Before revocation: both live sessions are in the matter's SSE audience.
    const beforeAudience = await resolveWorkspaceRealtimeAudience(
      {
        sessionIds: [revokedSessionId, activeSessionId],
        workspaceId: matterId,
      },
      testDb,
    );
    expect(beforeAudience.has(revokedSessionId)).toBe(true);
    expect(beforeAudience.has(activeSessionId)).toBe(true);

    // Revoke matter membership for revokedUserId.
    await testDb
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, matterId),
          eq(workspaceMembers.userId, revokedUserId),
        ),
      );

    // After revocation: forbidden probe excluded, authorized control retained.
    const afterAudience = await resolveWorkspaceRealtimeAudience(
      {
        sessionIds: [revokedSessionId, activeSessionId],
        workspaceId: matterId,
      },
      testDb,
    );
    expect(afterAudience.has(revokedSessionId)).toBe(false);
    expect(afterAudience.has(activeSessionId)).toBe(true);
  });
});
