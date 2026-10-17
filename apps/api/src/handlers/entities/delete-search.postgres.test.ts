import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  searchDocuments,
  workspaceMembers,
  workspaceSearchDocuments,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createPgFtsSearchReader } from "@/api/lib/search/pg-fts-provider";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { deleteEntitiesHandler } from "./delete";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("document deletion search projection against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("deleting a document removes its search row, preserves its sibling and commits matter search activity", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const setup = openClient();
      const request = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const deletedId = createSafeId<"entity">();
      const siblingId = createSafeId<"entity">();
      const deletedVersionId = createSafeId<"entityVersion">();
      const siblingVersionId = createSafeId<"entityVersion">();
      const initialActivityAt = new Date("2001-01-01T00:00:00Z");
      const versionCreatedAt = new Date("2000-01-01T00:00:00Z");
      const rlsDb = markRlsDatabase(request.db);
      const safeDb = createSafeDb(rlsDb, [workspaceId], organizationId, userId);
      const scopedDb = createScopedDb(
        rlsDb,
        [workspaceId],
        organizationId,
        userId,
      );
      const reader = createPgFtsSearchReader(scopedDb);
      const readHits = async () =>
        await reader.search({
          query: "deletionsearch",
          organizationId,
          userId,
          workspaceId,
          limit: 10,
        });
      const readSiblingSnapshot = async () =>
        await setup.db.execute(sql`
          SELECT row_to_json(sd)::text AS snapshot
          FROM search_documents sd WHERE sd.entity_id = ${siblingId}
        `);

      try {
        await setup.db.insert(organization).values({
          id: organizationId,
          name: "Deletion search organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await setup.db.insert(user).values({
          id: userId,
          name: "Deletion search member",
          email: `${userId}@example.test`,
        });
        await setup.db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        await setup.db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Deletion search matter",
          reference: "SEARCH",
          lastActivityAt: initialActivityAt,
        });
        await setup.db.insert(workspaceMembers).values({
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId,
        });
        await setup.db.insert(entities).values([
          {
            id: deletedId,
            workspaceId,
            kind: "document",
            name: "Deleted deletionsearch document",
            docSequence: 1,
          },
          {
            id: siblingId,
            workspaceId,
            kind: "document",
            name: "Sibling deletionsearch document",
            docSequence: 2,
          },
        ]);
        await setup.db.insert(entityVersions).values([
          {
            id: deletedVersionId,
            entityId: deletedId,
            workspaceId,
            createdAt: versionCreatedAt,
          },
          {
            id: siblingVersionId,
            entityId: siblingId,
            workspaceId,
            createdAt: versionCreatedAt,
          },
        ]);
        await setup.db
          .update(entities)
          .set({ currentVersionId: deletedVersionId })
          .where(eq(entities.id, deletedId));
        await setup.db
          .update(entities)
          .set({ currentVersionId: siblingVersionId })
          .where(eq(entities.id, siblingId));
        await setup.db.insert(searchDocuments).values([
          {
            entityId: deletedId,
            organizationId,
            workspaceId,
            kind: "document",
            title: "Deleted deletionsearch document",
            searchableText: "deletionsearch deleted content",
            language: "simple",
            tsv: sql`to_tsvector('simple', 'deletionsearch deleted content')`,
            updatedAt: initialActivityAt,
          },
          {
            entityId: siblingId,
            organizationId,
            workspaceId,
            kind: "document",
            title: "Sibling deletionsearch document",
            searchableText: "deletionsearch sibling content",
            language: "simple",
            previewGeneration: Bun.randomUUIDv7(),
            tsv: sql`to_tsvector('simple', 'deletionsearch sibling content')`,
            updatedAt: initialActivityAt,
          },
        ]);
        await setup.db.insert(workspaceSearchDocuments).values({
          workspaceId,
          organizationId,
          title: "Deletion search matter",
          updatedAt: initialActivityAt,
        });

        const before = await readHits();
        expect(new Set(before.hits.map(({ entityId }) => entityId))).toEqual(
          new Set([deletedId, siblingId]),
        );
        expect(before.totalCount).toBe(2);
        const siblingBefore = await readSiblingSnapshot();
        expect(siblingBefore).toHaveLength(1);

        const outcome = await Result.gen(() =>
          deleteEntitiesHandler({
            safeDb,
            organizationId,
            userId,
            workspaceId,
            body: { entityIds: [deletedId] },
            recordAuditEvent: createAuditRecorder({
              organizationId,
              workspaceId,
              userId,
              request: new Request("https://api.example.test/v1/entities"),
              server: null,
            }),
          }),
        );
        expect(outcome).toEqual(Result.ok({}));
        expect(
          await setup.db
            .select()
            .from(searchDocuments)
            .where(eq(searchDocuments.entityId, deletedId)),
        ).toEqual([]);
        expect(await readSiblingSnapshot()).toEqual(siblingBefore);
        const after = await readHits();
        expect(after.hits.map(({ entityId }) => entityId)).toEqual([siblingId]);
        expect(after.totalCount).toBe(1);

        const activityRows = await setup.db
          .select({
            lastActivityAt: workspaces.lastActivityAt,
            searchUpdatedAt: workspaceSearchDocuments.updatedAt,
          })
          .from(workspaces)
          .innerJoin(
            workspaceSearchDocuments,
            eq(workspaceSearchDocuments.workspaceId, workspaces.id),
          )
          .where(eq(workspaces.id, workspaceId));
        const activity = activityRows.at(0);
        expect(activity).toBeDefined();
        expect(activity?.lastActivityAt.getTime()).toBeGreaterThan(
          initialActivityAt.getTime(),
        );
        expect(activity?.searchUpdatedAt).toEqual(activity?.lastActivityAt);
      } finally {
        await setup.db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await setup.db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
