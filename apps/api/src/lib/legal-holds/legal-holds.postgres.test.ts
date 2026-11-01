import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  chatThreads,
  contacts,
  entities,
  entityDeletionCleanupRequests,
  entityVersions,
  folioCollabRooms,
  legalHolds,
  properties,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { EMPTY_CHAT_HISTORY_SNAPSHOT } from "@/api/handlers/chat/history-window";
import { rollbackUnpersistedChatSideEffects } from "@/api/handlers/chat/send-message-side-effects";
import { deleteContactHandler } from "@/api/handlers/contacts/delete";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { moveEntities } from "@/api/handlers/entities/move";
import { createWorkspaceContactHandler } from "@/api/handlers/workspaces/contacts/create";
import { deleteWorkspaceContactHandler } from "@/api/handlers/workspaces/contacts/delete";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { createFileKey } from "@/api/lib/files/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-mime";
import { completeWorkspaceDeletion } from "@/api/lib/organization-storage-teardown";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import { holdsBlocking, requireNoHold } from "./holds";
import { placeLegalHold, releaseLegalHold } from "./lifecycle";

const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "legal holds (postgres)",
  () => {
    test("matter, item, client and organization deletion are refused until an audited release; tenant isolation is preserved", async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL is required for Postgres tests");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: client } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const otherOrganizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const folderId = createSafeId<"entity">();
        const entityId = createSafeId<"entity">();
        const rawEntityId = createSafeId<"entity">();
        const workspaceContactId = createSafeId<"workspaceContact">();
        const folderVersionId = createSafeId<"entityVersion">();
        const entityVersionId = createSafeId<"entityVersion">();
        const contactId = createSafeId<"contact">();
        const cleanupId = createSafeId<"entityDeletionCleanupRequest">();
        const recordAuditEvent = createAuditRecorder({
          organizationId,
          workspaceId,
          userId,
          request: new Request("http://localhost/legal-holds"),
          server: null,
        });
        try {
          await db.insert(user).values({
            id: userId,
            name: "Hold owner",
            email: `${userId}@hold.test`,
          });
          await db.insert(organization).values([
            {
              id: organizationId,
              name: "Held organization",
              slug: organizationId,
              createdAt: new Date(),
            },
            {
              id: otherOrganizationId,
              name: "Other organization",
              slug: otherOrganizationId,
              createdAt: new Date(),
            },
          ]);
          await db.insert(member).values([
            {
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            },
            {
              id: mintAuthProviderIdValue(),
              organizationId: otherOrganizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            },
          ]);
          await db.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Client",
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Held matter",
            reference: "HOLD-1",
            clientId: contactId,
          });
          await db.insert(workspaceMembers).values({
            id: createSafeId<"workspaceMember">(),
            workspaceId,
            userId,
          });
          await db.insert(workspaceContacts).values({
            id: workspaceContactId,
            organizationId,
            workspaceId,
            contactId,
            role: "other",
          });
          await db.insert(entities).values([
            {
              id: folderId,
              workspaceId,
              kind: "folder",
              name: "Evidence folder",
            },
            {
              id: entityId,
              workspaceId,
              parentId: folderId,
              name: "Evidence",
            },
            {
              id: rawEntityId,
              workspaceId,
              name: "Raw deletion target",
            },
          ]);
          await db.insert(entityVersions).values([
            {
              id: folderVersionId,
              entityId: folderId,
              workspaceId,
              versionNumber: 1,
            },
            {
              id: entityVersionId,
              entityId,
              workspaceId,
              versionNumber: 1,
            },
          ]);
          const propertyOneId = createSafeId<"property">();
          const propertyTwoId = createSafeId<"property">();
          const propertyThreeId = createSafeId<"property">();
          await db.insert(properties).values([
            {
              id: propertyOneId,
              workspaceId,
              name: "Collaboration file 1",
              status: "fresh",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              kinds: ["document"],
            },
            {
              id: propertyTwoId,
              workspaceId,
              name: "Collaboration file 2",
              status: "fresh",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              kinds: ["document"],
            },
            {
              id: propertyThreeId,
              workspaceId,
              name: "Collaboration file 3",
              status: "fresh",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              kinds: ["document"],
            },
          ]);
          const collabFileOne = {
            yjsSnapshotFileId: createSafeId<"userFile">(),
            docxCheckpointFileId: createSafeId<"userFile">(),
          };
          const collabFileTwo = {
            yjsSnapshotFileId: createSafeId<"userFile">(),
            docxCheckpointFileId: createSafeId<"userFile">(),
          };
          const collabFileThree = {
            yjsSnapshotFileId: createSafeId<"userFile">(),
            docxCheckpointFileId: createSafeId<"userFile">(),
          };
          const collabFileFour = {
            yjsSnapshotFileId: createSafeId<"userFile">(),
            docxCheckpointFileId: createSafeId<"userFile">(),
          };
          const collabFiles = [
            collabFileOne,
            collabFileTwo,
            collabFileThree,
            collabFileFour,
          ];
          const persistedAt = new Date();
          const collabRoom = (
            targetEntityId: typeof folderId,
            versionId: typeof folderVersionId,
            propertyId: typeof propertyOneId,
            files: (typeof collabFiles)[number],
            index: number,
          ) =>
            ({
              id: createSafeId<"folioCollabRoom">(),
              workspaceId,
              entityId: targetEntityId,
              propertyId,
              baseVersionId: versionId,
              sourceVersionId: versionId,
              fileName: `collaboration-${index + 1}.docx`,
              ...files,
              yjsSnapshotRevision: 1,
              yjsSnapshotSizeBytes: 1,
              yjsSnapshotUpdatedAt: persistedAt,
              docxCheckpointUpdatedAt: persistedAt,
              seedState: "seeded",
              seedClaimedAt: persistedAt,
              seededAt: persistedAt,
            }) satisfies typeof folioCollabRooms.$inferInsert;
          await db
            .insert(folioCollabRooms)
            .values([
              collabRoom(
                entityId,
                entityVersionId,
                propertyOneId,
                collabFileOne,
                0,
              ),
              collabRoom(
                entityId,
                entityVersionId,
                propertyTwoId,
                collabFileTwo,
                1,
              ),
              collabRoom(
                entityId,
                entityVersionId,
                propertyThreeId,
                collabFileThree,
                2,
              ),
              collabRoom(
                folderId,
                folderVersionId,
                propertyOneId,
                collabFileFour,
                3,
              ),
            ]);
          await db.insert(entityDeletionCleanupRequests).values({
            id: cleanupId,
            organizationId,
            workspaceId,
            s3Keys: [`${organizationId}/${workspaceId}/evidence.pdf`],
          });
          const invalidRelease = await Result.tryPromise(
            async () =>
              await db.insert(legalHolds).values({
                id: createSafeId<"legalHold">(),
                organizationId,
                scopeType: "matter",
                workspaceId,
                reason: "Evidence",
                placedBy: userId,
                releasedBy: userId,
                releasedAt: new Date(),
                releaseReason: null,
              }),
          );
          expect(invalidRelease.isErr()).toBe(true);
          const invalidReason = await Result.tryPromise(
            async () =>
              await db.insert(legalHolds).values({
                id: createSafeId<"legalHold">(),
                organizationId,
                scopeType: "matter",
                workspaceId,
                reason: "\t\n",
                placedBy: userId,
              }),
          );
          expect(invalidReason.isErr()).toBe(true);
          const scopedDb = createScopedDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          );
          const placedResult = await scopedDb(
            async (tx) =>
              await placeLegalHold({
                tx,
                organizationId,
                actorId: userId,
                scope: { type: "matter", workspaceId },
                reason: "Preserve evidence",
                recordAuditEvent,
              }),
          );
          if (placedResult.isErr()) {
            throw new TypeError("Expected placed hold");
          }
          const holdId = placedResult.value.id;
          for (const deletion of [
            async () =>
              await client`DELETE FROM workspaces WHERE id = ${workspaceId}`,
            async () =>
              await client`DELETE FROM entities WHERE id = ${rawEntityId}`,
            async () =>
              await client`DELETE FROM workspace_contacts WHERE id = ${workspaceContactId}`,
          ]) {
            const outcome = await Result.tryPromise(deletion);
            expect(outcome.isErr()).toBe(true);
            if (outcome.isErr()) {
              expect(outcome.error).toMatchObject({
                cause: {
                  message: expect.stringContaining("active legal hold"),
                },
              });
            }
          }
          expect(
            await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, rawEntityId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: workspaceContacts.id })
              .from(workspaceContacts)
              .where(eq(workspaceContacts.id, workspaceContactId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: legalHolds.id })
              .from(legalHolds)
              .where(eq(legalHolds.id, holdId)),
          ).toHaveLength(1);
          const directHoldDelete = await Result.tryPromise(
            async () =>
              await client.begin(async (tx) => {
                await tx`SET LOCAL ROLE stella`;
                await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
                await tx`DELETE FROM legal_holds WHERE id = ${holdId}`;
              }),
          );
          expect(directHoldDelete.isErr()).toBe(true);
          // Matter teardown runs in the owner transaction, as the deletion
          // command runs it.
          const refused = await Result.tryPromise(
            async () =>
              await withAggregateTransaction(
                db,
                async (tx) =>
                  await completeWorkspaceDeletion({
                    tx,
                    organizationId,
                    workspaceId,
                  }),
              ),
          );
          expect(Result.isError(refused)).toBe(true);
          if (Result.isError(refused)) {
            expect(resolveHandlerError(refused.error)).toMatchObject({
              status: 409,
              code: LEGAL_HOLD_ACTIVE,
            });
          }
          expect(
            await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, entityId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: entityDeletionCleanupRequests.id })
              .from(entityDeletionCleanupRequests)
              .where(eq(entityDeletionCleanupRequests.id, cleanupId)),
          ).toHaveLength(1);
          const safeDb = createSafeDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          );
          const entityDelete = await Result.gen(() =>
            deleteEntitiesHandler({
              safeDb,
              organizationId,
              workspaceId,
              recordAuditEvent,
              body: { entityIds: [entityId] },
            }),
          );
          expect(entityDelete.isErr()).toBe(true);
          if (entityDelete.isErr()) {
            expect(resolveHandlerError(entityDelete.error)).toMatchObject({
              status: 409,
              code: LEGAL_HOLD_ACTIVE,
            });
          }
          const contactDelete = await Result.gen(() =>
            deleteContactHandler({
              safeDb,
              organizationId,
              contactId,
              recordAuditEvent,
            }),
          );
          expect(contactDelete.isErr()).toBe(true);
          if (contactDelete.isErr()) {
            expect(resolveHandlerError(contactDelete.error)).toMatchObject({
              status: 409,
              code: LEGAL_HOLD_ACTIVE,
            });
          }
          expect(
            await db
              .select({ id: contacts.id })
              .from(contacts)
              .where(eq(contacts.id, contactId)),
          ).toHaveLength(1);
          const entityRefusal = await scopedDb(
            async (tx) =>
              await requireNoHold({
                tx,
                organizationId,
                target: { type: "entity", entityId },
              }),
          );
          expect(entityRefusal.isErr()).toBe(true);
          const contactRefusal = await scopedDb(
            async (tx) =>
              await requireNoHold({
                tx,
                organizationId,
                target: { type: "contacts", ids: [contactId] },
              }),
          );
          expect(contactRefusal.isErr()).toBe(true);
          const organizationRefusal = await scopedDb(
            async (tx) =>
              await requireNoHold({
                tx,
                organizationId,
                target: { type: "organization" },
              }),
          );
          expect(organizationRefusal.isErr()).toBe(true);
          const otherDb = createScopedDb(
            markRlsDatabase(db),
            [],
            otherOrganizationId,
            userId,
          );
          expect(
            await otherDb(async (tx) => await tx.select().from(legalHolds)),
          ).toEqual([]);
          const invisible = await otherDb(
            async (tx) =>
              await holdsBlocking({
                tx,
                organizationId: otherOrganizationId,
                target: { type: "organization" },
              }),
          );
          expect(invisible).toEqual({ type: "clear" });
          const forbiddenRelease = await otherDb(
            async (tx) =>
              await releaseLegalHold({
                tx,
                organizationId: otherOrganizationId,
                actorId: userId,
                scope: { type: "matter", workspaceId },
                holdId,
                reason: "Attempt",
                recordAuditEvent,
              }),
          );
          expect(forbiddenRelease.isErr()).toBe(true);
          const released = await scopedDb(
            async (tx) =>
              await releaseLegalHold({
                tx,
                organizationId,
                actorId: userId,
                scope: { type: "matter", workspaceId },
                holdId,
                reason: "Proceed with deletion",
                recordAuditEvent,
              }),
          );
          expect(released.isOk()).toBe(true);
          await client`DELETE FROM entities WHERE id = ${rawEntityId}`;
          await client`DELETE FROM workspace_contacts WHERE id = ${workspaceContactId}`;
          const itemHold = await scopedDb(
            async (tx) =>
              await placeLegalHold({
                tx,
                organizationId,
                actorId: userId,
                scope: { type: "entity", workspaceId, entityId },
                reason: "Retain this item",
                recordAuditEvent,
              }),
          );
          if (itemHold.isErr()) {
            throw new TypeError("Expected item hold");
          }
          const folderDelete = await Result.gen(() =>
            deleteEntitiesHandler({
              safeDb,
              organizationId,
              workspaceId,
              recordAuditEvent,
              body: { entityIds: [folderId] },
            }),
          );
          expect(folderDelete.isErr()).toBe(true);
          if (folderDelete.isErr()) {
            expect(resolveHandlerError(folderDelete.error)).toMatchObject({
              status: 409,
              code: LEGAL_HOLD_ACTIVE,
              issues: [{ path: itemHold.value.id }],
            });
          }
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, folderId)),
          ).toHaveLength(1);
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.id, entityId)),
          ).toHaveLength(1);
          expect(
            (
              await scopedDb(
                async (tx) =>
                  await requireNoHold({
                    tx,
                    organizationId,
                    target: { type: "entity", entityId },
                  }),
              )
            ).isErr(),
          ).toBe(true);
          expect(
            (
              await scopedDb(
                async (tx) =>
                  await requireNoHold({
                    tx,
                    organizationId,
                    target: { type: "matter", workspaceId },
                  }),
              )
            ).isErr(),
          ).toBe(true);
          const itemReleased = await scopedDb(
            async (tx) =>
              await releaseLegalHold({
                tx,
                organizationId,
                actorId: userId,
                scope: { type: "entity", workspaceId, entityId },
                holdId: itemHold.value.id,
                reason: "Item released",
                recordAuditEvent,
              }),
          );
          expect(itemReleased.isOk()).toBe(true);
          const audit = await db
            .select({
              action: auditLogs.action,
              resourceType: auditLogs.resourceType,
              changes: auditLogs.changes,
            })
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId))
            .orderBy(auditLogs.createdAt, auditLogs.id);
          expect(audit.map((event) => event.action)).toEqual([
            "legal_hold.placed",
            "legal_hold.released",
            "legal_hold.placed",
            "legal_hold.released",
          ]);
          expect(
            audit.every((event) => event.resourceType === "legal_hold"),
          ).toBe(true);
          expect(audit.at(0)?.changes).toMatchObject({
            reason: { old: null, new: "Preserve evidence" },
          });
          expect(audit.at(1)?.changes).toMatchObject({
            releaseReason: { old: null, new: "Proceed with deletion" },
          });
          const deletedFolder = await Result.gen(() =>
            deleteEntitiesHandler({
              enqueueCleanup: async () => {},
              safeDb,
              organizationId,
              workspaceId,
              recordAuditEvent,
              body: { entityIds: [folderId] },
            }),
          );
          expect(deletedFolder.isOk()).toBe(true);
          expect(
            await db
              .select({ id: entities.id })
              .from(entities)
              .where(inArray(entities.id, [folderId, entityId])),
          ).toEqual([]);
          expect(
            await db
              .select({ id: folioCollabRooms.id })
              .from(folioCollabRooms)
              .where(inArray(folioCollabRooms.entityId, [folderId, entityId])),
          ).toEqual([]);
          const cleanupKeys = (
            await db
              .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
              .from(entityDeletionCleanupRequests)
              .where(eq(entityDeletionCleanupRequests.workspaceId, workspaceId))
          ).flatMap(({ s3Keys }) => s3Keys);
          expect(cleanupKeys).toEqual(
            expect.arrayContaining(
              collabFiles.flatMap(
                ({ yjsSnapshotFileId, docxCheckpointFileId }) => [
                  createFileKey({
                    organizationId,
                    workspaceId,
                    fileId: yjsSnapshotFileId,
                    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
                  }),
                  createFileKey({
                    organizationId,
                    workspaceId,
                    fileId: docxCheckpointFileId,
                    mimeType: DOCX_MIME_TYPE,
                  }),
                ],
              ),
            ),
          );
          await withAggregateTransaction(
            db,
            async (tx) =>
              await completeWorkspaceDeletion({
                tx,
                organizationId,
                workspaceId,
              }),
          );
          expect(
            await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId)),
          ).toEqual([]);
        } finally {
          await db
            .delete(entityDeletionCleanupRequests)
            .where(eq(entityDeletionCleanupRequests.id, cleanupId));
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, otherOrganizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, otherOrganizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("a matter hold placed after thread creation refuses rollback and preserves the thread", async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL is required for Postgres tests");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const threadId = createSafeId<"chatThread">();
        const rollbackToken = "held-thread-rollback";
        const recordAuditEvent = createAuditRecorder({
          organizationId,
          workspaceId,
          userId,
          request: new Request("http://localhost/legal-holds/thread-rollback"),
          server: null,
        });
        try {
          await db.insert(user).values({
            id: userId,
            name: "Rollback hold owner",
            email: `${userId}@hold.test`,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Rollback hold organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Rollback hold matter",
            reference: "HOLD-ROLLBACK",
          });
          await db.insert(chatThreads).values({
            id: threadId,
            organizationId,
            workspaceId,
            userId,
            title: "Unpersisted thread",
            rollbackToken,
            dataWorkspaceIds: [workspaceId],
          });
          await db.insert(legalHolds).values({
            id: createSafeId<"legalHold">(),
            organizationId,
            scopeType: "matter",
            workspaceId,
            reason: "Retain newly created chat",
            placedBy: userId,
          });

          const rollback = await rollbackUnpersistedChatSideEffects({
            organizationId,
            recordAuditEvent,
            safeDb: createSafeDb(
              markRlsDatabase(db),
              [workspaceId],
              organizationId,
              userId,
            ),
            threadId,
            threadState: {
              type: "created",
              rollbackToken,
              data: {
                id: threadId,
                workspaceId,
                contextMatterIds: [],
                dataWorkspaceIds: [workspaceId],
                webSearchEnabled: false,
                chatModel: null,
                chatReasoningEffort: null,
                messages: [],
                historySnapshot: EMPTY_CHAT_HISTORY_SNAPSHOT,
              },
            },
            uploadedFiles: [],
            userId,
          });

          expect(rollback.isErr()).toBe(true);
          if (rollback.isErr()) {
            expect(resolveHandlerError(rollback.error)).toMatchObject({
              status: 409,
              code: LEGAL_HOLD_ACTIVE,
            });
          }
          expect(
            await db
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .where(eq(chatThreads.id, threadId)),
          ).toEqual([{ id: threadId }]);
        } finally {
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("held matter contact relationships cannot be removed or raced by contact deletion", async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL is required for Postgres tests");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const linkedContactId = createSafeId<"contact">();
        const raceContactId = createSafeId<"contact">();
        const replacementContactId = createSafeId<"contact">();
        const workspaceContactId = createSafeId<"workspaceContact">();
        const recordAuditEvent = createAuditRecorder({
          organizationId,
          workspaceId,
          userId,
          request: new Request("http://localhost/legal-hold-contacts"),
          server: null,
        });
        const safeDbFor =
          (tx: Transaction): SafeDb =>
          async (run) =>
            await Result.tryPromise(async () => await run(tx));
        try {
          await db.insert(user).values({
            id: userId,
            name: "Contact hold owner",
            email: `${userId}@hold.test`,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Contact hold organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await db.insert(contacts).values(
            [linkedContactId, raceContactId, replacementContactId].map(
              (id, index) => ({
                id,
                organizationId,
                type: "person" as const,
                displayName: `Held contact ${index + 1}`,
              }),
            ),
          );
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Held contact matter",
            reference: "HOLD-CONTACTS",
            clientId: linkedContactId,
          });
          await db.insert(workspaceContacts).values({
            id: workspaceContactId,
            organizationId,
            workspaceId,
            contactId: linkedContactId,
            role: "witness",
          });
          await db.insert(legalHolds).values({
            id: createSafeId<"legalHold">(),
            organizationId,
            scopeType: "matter",
            workspaceId,
            reason: "Retain matter contacts",
            placedBy: userId,
          });

          const safeDb = createSafeDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          );
          const unlink = await Result.gen(() =>
            deleteWorkspaceContactHandler({
              safeDb,
              organizationId,
              workspaceId,
              workspaceContactId,
              recordAuditEvent,
            }),
          );
          expect(unlink.isErr()).toBe(true);
          if (unlink.isErr()) {
            expect(resolveHandlerError(unlink.error)).toMatchObject({
              code: LEGAL_HOLD_ACTIVE,
            });
          }

          const clientChange = await Result.gen(() =>
            updateWorkspaceHandler({
              safeDb,
              organizationId,
              workspaceId,
              recordAuditEvent,
              body: { clientId: replacementContactId },
            }),
          );
          expect(clientChange.isErr()).toBe(true);
          if (clientChange.isErr()) {
            expect(resolveHandlerError(clientChange.error)).toMatchObject({
              code: LEGAL_HOLD_ACTIVE,
            });
          }

          const linkedDelete = await Result.gen(() =>
            deleteContactHandler({
              safeDb,
              organizationId,
              contactId: linkedContactId,
              recordAuditEvent,
            }),
          );
          expect(linkedDelete.isErr()).toBe(true);
          if (linkedDelete.isErr()) {
            expect(resolveHandlerError(linkedDelete.error)).toMatchObject({
              code: LEGAL_HOLD_ACTIVE,
            });
          }

          await withInterleaving({
            databaseUrl,
            schedules: [["a.link", "b.delete", "a.commit", "b.commit"]],
            a: {
              steps: [
                {
                  name: "link",
                  run: async (tx) => {
                    const result = await Result.gen(() =>
                      createWorkspaceContactHandler({
                        safeDb: safeDbFor(tx),
                        organizationId,
                        workspaceId,
                        recordAuditEvent,
                        body: { contactId: raceContactId, role: "witness" },
                      }),
                    );
                    expect(result.isOk()).toBe(true);
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "delete",
                  run: async (tx) => {
                    await Result.gen(() =>
                      deleteContactHandler({
                        safeDb: safeDbFor(tx),
                        organizationId,
                        contactId: raceContactId,
                        recordAuditEvent,
                      }),
                    );
                  },
                },
              ],
            },
            reset: async () => {
              await db
                .delete(workspaceContacts)
                .where(eq(workspaceContacts.contactId, raceContactId));
            },
            readState: async () => ({
              contact: await db.query.contacts.findFirst({
                where: { id: { eq: raceContactId } },
              }),
              link: await db.query.workspaceContacts.findFirst({
                where: { contactId: { eq: raceContactId } },
              }),
            }),
            invariant: ({ state }) => {
              expect(state.contact).toBeDefined();
              expect(state.link).toBeDefined();
            },
          });
        } finally {
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("moving a held item into a concurrently deleted folder cannot bypass the hold", async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL is required for Postgres tests");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const folderId = createSafeId<"entity">();
        const heldEntityId = createSafeId<"entity">();
        const holdId = createSafeId<"legalHold">();
        const recordAuditEvent = createAuditRecorder({
          organizationId,
          workspaceId,
          userId,
          request: new Request("http://localhost/legal-holds/concurrency"),
          server: null,
        });
        let deletionCode: string | undefined;
        try {
          await db.insert(user).values({
            id: userId,
            name: "Concurrent hold owner",
            email: `${userId}@hold.test`,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Concurrent hold organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Concurrent hold matter",
            reference: "HOLD-CONCURRENT",
          });
          await db.insert(entities).values([
            {
              id: folderId,
              workspaceId,
              kind: "folder",
              name: "Deletion target",
            },
            {
              id: heldEntityId,
              workspaceId,
              name: "Held evidence",
            },
          ]);
          await db.insert(legalHolds).values({
            id: holdId,
            organizationId,
            scopeType: "entity",
            entityId: heldEntityId,
            reason: "Retain during folder move",
            placedBy: userId,
          });

          await withInterleaving({
            databaseUrl,
            schedules: [["b.move", "a.delete", "b.commit", "a.commit"]],
            a: {
              steps: [
                {
                  name: "delete",
                  run: async (tx) => {
                    const deletion = await Result.gen(() =>
                      deleteEntitiesHandler({
                        safeDb: async (run) =>
                          await Result.tryPromise(async () => await run(tx)),
                        organizationId,
                        workspaceId,
                        recordAuditEvent,
                        body: { entityIds: [folderId] },
                      }),
                    );
                    const resolved = deletion.isErr()
                      ? resolveHandlerError(deletion.error)
                      : null;
                    deletionCode = resolved?.code;
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "move",
                  run: async (tx) => {
                    const moved = await moveEntities({
                      tx,
                      workspaceId,
                      entityIds: [heldEntityId],
                      parentId: folderId,
                      recordAuditEvent,
                    });
                    expect(moved.isOk()).toBe(true);
                  },
                },
              ],
            },
            reset: async () => {
              deletionCode = undefined;
              await db
                .update(entities)
                .set({ parentId: null })
                .where(eq(entities.id, heldEntityId));
            },
            readState: async () =>
              await db
                .select({ id: entities.id, parentId: entities.parentId })
                .from(entities)
                .where(inArray(entities.id, [folderId, heldEntityId])),
            invariant: ({ outcomes, state }) => {
              expect(outcomes.a.status).toBe("committed");
              expect(outcomes.b.status).toBe("committed");
              expect(deletionCode).toBe(LEGAL_HOLD_ACTIVE);
              expect(state).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ id: folderId }),
                  { id: heldEntityId, parentId: folderId },
                ]),
              );
            },
          });
        } finally {
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);
