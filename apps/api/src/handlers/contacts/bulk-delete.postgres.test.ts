import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { contacts, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import bulkDeleteContacts from "./bulk/delete";

const databaseUrl = process.env["DATABASE_URL"] ?? "";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "bulk contact delete concurrency (postgres)",
  () => {
    test("keeps a contact linked as a matter client before the delete starts", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const blockedContactId = createSafeId<"contact">();
        const plainContactId = createSafeId<"contact">();
        const workspaceId = createSafeId<"workspace">();
        const auditedIds: string[] = [];

        try {
          await setup.db.insert(user).values({
            id: userId,
            name: "Bulk delete committed client",
            email: `${userId}@bulk-delete.test`,
          });
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Bulk delete committed client",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await setup.db.insert(contacts).values([
            {
              id: blockedContactId,
              organizationId,
              type: "person",
              displayName: "Existing client",
            },
            {
              id: plainContactId,
              organizationId,
              type: "person",
              displayName: "Delete me",
            },
          ]);
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Matter",
            reference: `matter-${workspaceId}`,
            clientId: blockedContactId,
          });

          const response = await setup.db.transaction(async (tx) => {
            const safeDb: SafeDb = async (callback) =>
              await Result.tryPromise(async () => await callback(tx));
            return await bulkDeleteContacts.handler(
              createTestHandlerContext<
                Parameters<typeof bulkDeleteContacts.handler>[0]
              >({
                scopedDb: NO_DB,
                safeDb,
                audit: auditRecorderDouble((events) => {
                  auditedIds.push(
                    ...events.map(({ resourceId }) => resourceId),
                  );
                }),
                memberRole: sessionMemberRole("owner"),
                session: { activeOrganizationId: organizationId },
                user: { id: userId },
                body: { contactIds: [blockedContactId, plainContactId] },
              }),
            );
          });

          expect(response).toEqual({
            outcomes: [
              { contactId: blockedContactId, status: "blocked" },
              { contactId: plainContactId, status: "deleted" },
            ],
          });
          expect(auditedIds).toEqual([plainContactId]);
          expect(
            await setup.db
              .select({ id: contacts.id })
              .from(contacts)
              .where(eq(contacts.organizationId, organizationId)),
          ).toEqual([{ id: blockedContactId }]);
          expect(
            (
              await setup.db
                .select({ clientId: workspaces.clientId })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
            ).at(0),
          ).toEqual({ clientId: blockedContactId });
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("keeps a client assignment committed while the delete waits for its contact", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const blockedContactId = createSafeId<"contact">();
        const plainContactId = createSafeId<"contact">();
        const workspaceId = createSafeId<"workspace">();
        const auditedIds: string[] = [];
        const handlerResponse =
          Promise.withResolvers<
            Awaited<ReturnType<typeof bulkDeleteContacts.handler>>
          >();

        try {
          await setup.db.insert(user).values({
            id: userId,
            name: "Bulk delete concurrency",
            email: `${userId}@bulk-delete.test`,
          });
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Bulk delete concurrency",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await setup.db.insert(contacts).values([
            {
              id: blockedContactId,
              organizationId,
              type: "person",
              displayName: "Becomes client",
            },
            {
              id: plainContactId,
              organizationId,
              type: "person",
              displayName: "Delete me",
            },
          ]);
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Matter",
            reference: `matter-${workspaceId}`,
          });

          const results = await withInterleaving({
            databaseUrl,
            a: {
              steps: [
                {
                  name: "delete",
                  run: async (tx: Transaction) => {
                    const safeDb: SafeDb = async (callback) =>
                      await Result.tryPromise(async () => await callback(tx));
                    const response = await bulkDeleteContacts.handler(
                      createTestHandlerContext<
                        Parameters<typeof bulkDeleteContacts.handler>[0]
                      >({
                        scopedDb: NO_DB,
                        safeDb,
                        audit: auditRecorderDouble((events) => {
                          auditedIds.push(
                            ...events.map(({ resourceId }) => resourceId),
                          );
                        }),
                        memberRole: sessionMemberRole("owner"),
                        session: { activeOrganizationId: organizationId },
                        user: { id: userId },
                        body: {
                          contactIds: [blockedContactId, plainContactId],
                        },
                      }),
                    );
                    handlerResponse.resolve(response);
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "link-client",
                  run: async (tx: Transaction) => {
                    await tx
                      .update(workspaces)
                      .set({ clientId: blockedContactId })
                      .where(eq(workspaces.id, workspaceId));
                  },
                },
              ],
            },
            schedules: [["b.link-client", "a.delete", "b.commit", "a.commit"]],
            reset: async () => await Promise.resolve(),
            readState: async () => ({
              contacts: await setup.db
                .select({ id: contacts.id })
                .from(contacts)
                .where(eq(contacts.organizationId, organizationId)),
              matter: (
                await setup.db
                  .select({ clientId: workspaces.clientId })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId))
              ).at(0),
            }),
            invariant: ({ outcomes, state }) => {
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              expect(state.contacts).toEqual([{ id: blockedContactId }]);
              expect(state.matter).toEqual({ clientId: blockedContactId });
            },
          });

          expect(results.at(0)?.blocked).toContain("a.delete");
          expect(await handlerResponse.promise).toEqual({
            outcomes: [
              { contactId: blockedContactId, status: "blocked" },
              { contactId: plainContactId, status: "deleted" },
            ],
          });
          expect(auditedIds).toEqual([plainContactId]);
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);
