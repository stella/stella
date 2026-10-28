import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import { ZipArchive } from "@stll/docx-core/zip";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import { member, organization, user } from "@/api/db/auth-schema";
import {
  SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID,
  SETTING_ACCOUNT_EXPORT_USER_ID,
} from "@/api/db/rls";
import {
  aiMemories,
  contacts,
  entities,
  legalListClaims,
  legalListVerificationRuns,
  legalReaderAnnotations,
  searchHistoryEntries,
  workspaceMembers,
  workspaces,
  workspaceViewTemplates,
} from "@/api/db/schema";
import {
  createMembershipScopedDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { prepareSearchHistoryRows } from "@/api/handlers/search-history/entries";
import {
  type AccountExportArchiveDeps,
  buildAccountExportArchive,
} from "@/api/lib/account-export/archive";
import { readAccountExportAnnotationPage } from "@/api/lib/account-export/owner-read";
import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import {
  ACCOUNT_EXPORT_REGISTRY,
  EXPORTED_ACCOUNT_TABLE_NAMES,
} from "@/api/lib/account-export/registry";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("account export personal data", () => {
  test("exports only the requesting author's private annotations and verification-claim comments", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const scopedDatabase = markRlsDatabase(db);
      const organizationId = mintAuthProviderId<"organization">();
      const exportingUserId = mintAuthProviderId<"user">();
      const otherUserId = mintAuthProviderId<"user">();
      const users = [exportingUserId, otherUserId];
      const membershipIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const verificationRunId = createSafeId<"legalListVerificationRun">();
      const verificationClaimId = createSafeId<"legalListClaim">();
      const ownTemplateId = createSafeId<"workspaceViewTemplate">();
      const otherTemplateId = createSafeId<"workspaceViewTemplate">();
      const createdAt = new Date("2026-10-18T10:00:00.000Z");
      const updatedAt = new Date("2026-10-18T11:00:00.000Z");
      const ownComments = [
        {
          id: createSafeId<"legalReaderAnnotation">(),
          visibility: "shared" as const,
          body: "Exporting author's shared comment",
        },
        {
          id: createSafeId<"legalReaderAnnotation">(),
          visibility: "private" as const,
          body: "Exporting author's private comment",
        },
      ];
      const otherComments = [
        {
          id: createSafeId<"legalReaderAnnotation">(),
          visibility: "shared" as const,
          body: "Other author's shared comment",
        },
        {
          id: createSafeId<"legalReaderAnnotation">(),
          visibility: "private" as const,
          body: "Other author's private comment",
        },
      ];
      await db.insert(user).values(
        users.map((id) => ({
          id,
          name: "Claim comment author",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Claim comment organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await recordNewOrganizationAccessState(db, {
          organizationId,
          now: new Date(),
        });
        await db.insert(member).values(
          users.map((userId, index) => ({
            id: membershipIds[index] ?? panic("Membership id required"),
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          })),
        );
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Claim comment matter",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(workspaceMembers).values(
          users.map((userId) => ({
            id: createSafeId<"workspaceMember">(),
            workspaceId,
            userId,
          })),
        );
        await db.insert(workspaceViewTemplates).values([
          {
            id: ownTemplateId,
            organizationId,
            userId: exportingUserId,
            name: "Exporting author's template",
            layout: {
              type: "filesystem",
              version: 1,
              filters: [],
              sorts: [],
              hiddenProperties: [],
              calculations: [],
            },
          },
          {
            id: otherTemplateId,
            organizationId,
            userId: otherUserId,
            name: "Other author's template",
            layout: {
              type: "filesystem",
              version: 1,
              filters: [],
              sorts: [],
              hiddenProperties: [],
              calculations: [],
            },
          },
        ]);
        await db.insert(entities).values({
          id: entityId,
          workspaceId,
          name: "Verified document",
        });
        await db.insert(legalListVerificationRuns).values({
          id: verificationRunId,
          organizationId,
          workspaceId,
          entityId,
          fileFieldId: createSafeId<"field">(),
          entityVersionId: createSafeId<"entityVersion">(),
          contentSha256: "a".repeat(64),
          evidence: { listId: createSafeId<"legalList">(), facts: [] },
          status: "completed",
          entityFeatureGate: "open",
        });
        await createScopedDb(
          scopedDatabase,
          [workspaceId],
          organizationId,
          exportingUserId,
        )(
          async (tx) =>
            await tx.insert(legalListClaims).values({
              id: verificationClaimId,
              workspaceId,
              runId: verificationRunId,
              position: 1,
              type: "fact",
              state: "supported",
              score: 100,
              text: "Claim",
              anchor: {
                type: "docx-block",
                blockId: "claim",
                start: 0,
                end: 5,
              },
              refs: [{ factEntityId: entityId, rel: "supports" }],
              entityFeatureGate: "open",
            }),
        );
        const annotation = (
          userId: SafeId<"user">,
          comment: (typeof ownComments)[number],
        ) => ({
          ...comment,
          organizationId,
          userId,
          targetType: "verification-claim" as const,
          targetId: verificationClaimId,
          workspaceId,
          verificationRunId,
          verificationClaimId,
          kind: "comment" as const,
          color: null,
          style: null,
          blockAnchorId: "claim",
          startOffset: 0,
          endOffset: 5,
          quote: "Claim",
          createdAt,
          updatedAt,
        });
        await createScopedDb(
          scopedDatabase,
          [workspaceId],
          organizationId,
          exportingUserId,
        )(
          async (tx) =>
            await tx
              .insert(legalReaderAnnotations)
              .values(
                ownComments.map((comment) =>
                  annotation(exportingUserId, comment),
                ),
              ),
        );
        await createScopedDb(
          scopedDatabase,
          [workspaceId],
          organizationId,
          otherUserId,
        )(
          async (tx) =>
            await tx
              .insert(legalReaderAnnotations)
              .values(
                otherComments.map((comment) =>
                  annotation(otherUserId, comment),
                ),
              ),
        );

        await db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, exportingUserId),
            ),
          );

        const annotationsOutsideExport = await createMembershipScopedDb(
          scopedDatabase,
          {
            organizationId,
            serverValidatedWorkspaceIds: [],
            userId: exportingUserId,
          },
        )(
          async (tx) =>
            await tx
              .select({ id: legalReaderAnnotations.id })
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.userId, exportingUserId)),
        );
        expect(annotationsOutsideExport).toEqual([]);

        const annotationsWithAppExportSettings = await createMembershipScopedDb(
          scopedDatabase,
          {
            organizationId,
            serverValidatedWorkspaceIds: [],
            userId: exportingUserId,
          },
        )(async (tx) => {
          await tx.execute(sql`SELECT
            set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID)}', ${organizationId}, true),
            set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_USER_ID)}', ${exportingUserId}, true)`);
          return await tx
            .select({ id: legalReaderAnnotations.id })
            .from(legalReaderAnnotations)
            .where(
              and(
                eq(legalReaderAnnotations.organizationId, organizationId),
                eq(legalReaderAnnotations.workspaceId, workspaceId),
              ),
            );
        });
        expect(annotationsWithAppExportSettings).toEqual([]);

        const privateDocumentId = Bun.randomUUIDv7();
        const privateNotes = users.map((userId) => ({
          id: createSafeId<"legalReaderAnnotation">(),
          organizationId,
          userId,
          targetType: "decision" as const,
          targetId: privateDocumentId,
          kind: "comment" as const,
          visibility: "private" as const,
          blockAnchorId: "private-note",
          startOffset: 0,
          endOffset: 5,
          quote: "Notes",
          body: "Private document note",
          createdAt,
          updatedAt,
        }));
        for (const note of privateNotes) {
          await createScopedDb(
            scopedDatabase,
            [],
            organizationId,
            note.userId,
          )(async (tx) => await tx.insert(legalReaderAnnotations).values(note));
        }
        const ownPrivateNote =
          privateNotes.at(0) ?? panic("Own private note required");
        const otherPrivateNote =
          privateNotes.at(1) ?? panic("Other private note required");

        const ownerAnnotationsWithUnrestrictedFilter =
          await readAccountExportAnnotationPage({
            database: db,
            organizationId,
            userId: exportingUserId,
            extraWhere: sql`true`,
            limit: 10,
          });
        expect(
          ownerAnnotationsWithUnrestrictedFilter.map(({ id }) => id).toSorted(),
        ).toEqual(
          [...ownComments.map(({ id }) => id), ownPrivateNote.id].toSorted(),
        );
        for (const { id } of [...otherComments, otherPrivateNote]) {
          expect(
            ownerAnnotationsWithUnrestrictedFilter.map((row) => row.id),
          ).not.toContain(id);
        }

        // Query the policy directly so the module's author bound cannot mask it.
        const ownerScopedAnnotations = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT
            set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID)}', ${organizationId}, true),
            set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_USER_ID)}', ${exportingUserId}, true)`);
          return await tx
            .select({ id: legalReaderAnnotations.id })
            .from(legalReaderAnnotations)
            .where(eq(legalReaderAnnotations.organizationId, organizationId));
        });
        expect(ownerScopedAnnotations.map(({ id }) => id).toSorted()).toEqual(
          [...ownComments.map(({ id }) => id), ownPrivateNote.id].toSorted(),
        );
        for (const { id } of [...otherComments, otherPrivateNote]) {
          expect(ownerScopedAnnotations.map((row) => row.id)).not.toContain(id);
        }

        const ownerAnnotationsWithoutSettings = await db.transaction(
          async (tx) =>
            await tx
              .select({ id: legalReaderAnnotations.id })
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.organizationId, organizationId)),
        );
        expect(ownerAnnotationsWithoutSettings).toEqual([]);

        const exported = await Array.fromAsync(
          exportAccountRows({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: exportingUserId,
            table: "legal_reader_annotations",
            signal: new AbortController().signal,
            scopedDatabase,
          }),
        );

        expect(exported).toHaveLength(ownComments.length + 1);
        expect(exported).toEqual(
          expect.arrayContaining([
            ...ownComments
              .toSorted((left, right) => compareCodeUnit(left.id, right.id))
              .map((comment) => ({
                organizationId,
                data: {
                  id: comment.id,
                  userId: exportingUserId,
                  targetType: "verification-claim",
                  targetId: verificationClaimId,
                  workspaceId,
                  verificationRunId,
                  verificationClaimId,
                  entityId: null,
                  pageTextSha256: null,
                  groupId: null,
                  kind: "comment",
                  visibility: comment.visibility,
                  color: null,
                  style: null,
                  blockAnchorId: "claim",
                  startOffset: 0,
                  endOffset: 5,
                  quote: "Claim",
                  body: comment.body,
                  createdAt: createdAt.toISOString(),
                  updatedAt: updatedAt.toISOString(),
                },
              })),
            {
              organizationId,
              data: expect.objectContaining({
                id: ownPrivateNote.id,
                userId: exportingUserId,
                targetType: "decision",
                visibility: "private",
              }),
            },
          ]),
        );
        for (const { id } of [...otherComments, otherPrivateNote]) {
          expect(exported).not.toContainEqual({
            organizationId,
            data: expect.objectContaining({ id }),
          });
        }

        const exportedAsOtherMember = await Array.fromAsync(
          exportAccountRows({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: otherUserId,
            table: "legal_reader_annotations",
            signal: new AbortController().signal,
            scopedDatabase,
          }),
        );

        expect(exportedAsOtherMember).toHaveLength(otherComments.length + 1);
        for (const { id } of [...otherComments, otherPrivateNote]) {
          expect(exportedAsOtherMember).toContainEqual({
            organizationId,
            data: expect.objectContaining({ id }),
          });
        }
        for (const { id } of [...ownComments, ownPrivateNote]) {
          expect(exportedAsOtherMember).not.toContainEqual({
            organizationId,
            data: expect.objectContaining({ id }),
          });
        }

        const exportedTemplates = await Array.fromAsync(
          exportAccountRows({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: exportingUserId,
            table: "workspace_view_templates",
            signal: new AbortController().signal,
            scopedDatabase,
          }),
        );
        expect(exportedTemplates).toEqual([
          {
            organizationId,
            data: expect.objectContaining({ id: ownTemplateId }),
          },
        ]);
        expect(exportedTemplates).not.toContainEqual({
          organizationId,
          data: expect.objectContaining({ id: otherTemplateId }),
        });

        const exportedMemberships = await Array.fromAsync(
          exportAccountRows({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: exportingUserId,
            table: "member",
            signal: new AbortController().signal,
            scopedDatabase,
          }),
        );
        expect(exportedMemberships).toHaveLength(1);
        expect(exportedMemberships).toContainEqual(
          expect.objectContaining({ id: membershipIds.at(0) }),
        );
        expect(exportedMemberships).not.toContainEqual(
          expect.objectContaining({ id: membershipIds.at(1) }),
        );
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(inArray(user.id, users));
      }
    });
  });

  test("projects encrypted personal history across memberships into the archive", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const scopedDatabase = markRlsDatabase(db);
      const organizations = [
        mintAuthProviderId<"organization">(),
        mintAuthProviderId<"organization">(),
      ];
      const organizationA = organizations.at(0);
      const organizationB = organizations.at(1);
      if (organizationA === undefined || organizationB === undefined) {
        panic("Two organization fixtures required");
      }
      const userId = mintAuthProviderId<"user">();
      const users = [userId];
      const workspaceId = createSafeId<"workspace">();
      const queries = ["First account query", "Second account query"];
      await db.insert(user).values(
        users.map((id) => ({
          id,
          name: "Export member",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values(
          organizations.map((id) => ({
            id,
            name: "Export organization",
            slug: id,
            createdAt: new Date(),
          })),
        );
        for (const organizationId of organizations) {
          await recordNewOrganizationAccessState(db, {
            organizationId,
            now: new Date(),
          });
        }
        await db.insert(member).values(
          organizations.flatMap((organizationId) =>
            users.map((memberUserId) => ({
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: memberUserId,
              role: "member",
              createdAt: new Date(),
            })),
          ),
        );
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId: organizationA,
          name: "Export matter fixture",
          reference: Bun.randomUUIDv7(),
        });
        await db.insert(contacts).values({
          organizationId: organizationA,
          createdBy: userId,
          type: "person",
          displayName: "Organization contact fixture",
        });
        const prepared = await Promise.all(
          organizations.map(async (organizationId, index) => {
            const query = queries.at(index);
            if (query === undefined) {
              panic("Organization query fixture required");
            }
            return await prepareSearchHistoryRows({ organizationId, userId }, [
              { entry: { kind: "search", query }, usedAt: new Date() },
            ]);
          }),
        );
        const historyRows = prepared.flat();
        for (const row of historyRows) {
          expect(row.iv.every((byte) => byte === 0)).toBe(false);
          for (const query of queries) {
            expect(row.ciphertext.includes(Buffer.from(query))).toBe(false);
          }
        }
        await db.insert(searchHistoryEntries).values(historyRows);
        await db.insert(aiMemories).values([
          {
            organizationId: organizationA,
            scope: "organization",
            kind: "instruction",
            content: "Organization memory fixture",
            dedupKey: "a".repeat(64),
            source: "user",
            createdBy: userId,
          },
          {
            organizationId: organizationA,
            scope: "workspace",
            workspaceId,
            kind: "fact",
            content: "Matter memory fixture",
            dedupKey: "b".repeat(64),
            source: "user",
            createdBy: userId,
          },
        ]);

        const archiveFor = async (exportUserId: SafeId<"user">) => {
          const published: Uint8Array[] = [];
          const deps = {
            rows: (options) =>
              exportAccountRows({ ...options, scopedDatabase }),
            files: (options) =>
              exportAccountFiles({ ...options, scopedDatabase }),
            openObject: async () => panic("The fixture has no personal files"),
            publish: async (_key, bytes) => {
              if (!(bytes instanceof Blob)) {
                panic("Expected the archive spool");
              }
              published.push(new Uint8Array(await bytes.arrayBuffer()));
            },
          } satisfies AccountExportArchiveDeps;
          await buildAccountExportArchive({
            projections: ACCOUNT_EXPORT_PROJECTIONS,
            db,
            userId: exportUserId,
            objectKey: "export-fixture.zip",
            signal: new AbortController().signal,
            deps,
          });
          const bytes = published.at(0);
          if (bytes === undefined) {
            panic("Archive publication required");
          }
          return await ZipArchive.read(bytes);
        };
        const archive = await archiveFor(userId);
        const historyText = await archive
          .entry("search_history_entries.json")
          ?.text();
        if (historyText === undefined) {
          panic("History archive entry required");
        }
        const history: unknown = JSON.parse(historyText);
        expect(history).toHaveLength(2);
        expect(history).toEqual(
          expect.arrayContaining([
            {
              organizationId: organizationA,
              data: expect.objectContaining({
                kind: "search",
                query: queries.at(0),
              }),
            },
            {
              organizationId: organizationB,
              data: expect.objectContaining({
                kind: "search",
                query: queries.at(1),
              }),
            },
          ]),
        );
        expect(await archive.entry("ai_memories.json")?.text()).toBe("[]");
        expect(archive.paths().toSorted()).toEqual(
          [
            ...EXPORTED_ACCOUNT_TABLE_NAMES.map((table) => `${table}.json`),
            "manifest.json",
          ].toSorted(),
        );
        for (const [table, disposition] of Object.entries(
          ACCOUNT_EXPORT_REGISTRY,
        )) {
          if (disposition.type === "exempt") {
            expect(archive.entry(`${table}.json`)).toBeUndefined();
          }
        }
      } finally {
        await db
          .delete(organization)
          .where(inArray(organization.id, organizations));
        await db.delete(user).where(inArray(user.id, users));
      }
    });
  });
});
