import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  contacts,
  entities,
  entityDeletionCleanupRequests,
  legalHolds,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { deleteContactHandler } from "@/api/handlers/contacts/delete";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { completeWorkspaceDeletion } from "@/api/lib/organization-storage-teardown";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

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
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const otherOrganizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
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
          await db
            .insert(entities)
            .values({ id: entityId, workspaceId, name: "Evidence" });
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
          const placed = await scopedDb(
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
          expect(Result.isOk(placed)).toBe(true);
          if (Result.isError(placed) || !placed.value) {
            throw new TypeError("Expected placed hold");
          }
          const holdId = placed.value.id;
          const refused = await Result.tryPromise(
            async () =>
              await scopedDb(
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
          if (itemHold.isErr() || !itemHold.value) {
            throw new TypeError("Expected item hold");
          }
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
          await scopedDb(
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
            "create",
            "update",
            "create",
            "update",
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
          await scopedDb(
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
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, otherOrganizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);
