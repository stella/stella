import { Result } from "better-result";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";
import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";

import { invitation, member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  properties,
  auditLogs,
  desktopEditHandoffs,
  pdfSigningSessions,
  desktopEditSessions,
  desktopPresence,
  entityVersions,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  mcpConnectors,
  mcpUserConnections,
  mcpOAuthState,
  sharepointConnections,
  sharepointOAuthState,
  workObligations,
  contacts,
  entities,
  taskAssignees,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createContactHandler } from "@/api/handlers/contacts/create";
import { updateContactHandler } from "@/api/handlers/contacts/update";
import {
  readDesktopPresence,
  reportDesktopPresence,
} from "@/api/handlers/desktop-presence/service";
import { addAssigneeHandler } from "@/api/handlers/tasks/assignees/add";
import { moveAssigneeHandler } from "@/api/handlers/tasks/assignees/move";
import { addWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/add";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import {
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { getAuth, resolveMemberAuthorization } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { executeFlowStep } from "@/api/lib/flows/flow-executor";
import {
  tryLockMemberCleanupWorkspace,
  removeOrganizationMemberInTransaction,
} from "@/api/lib/member-assignment-offboarding";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { signInHuman } from "@/api/tests/helpers/human-session";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

setDefaultTimeout(60_000);
const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const dependencies = {
  broadcastSessionEvent: () => undefined,
  broadcastWorkspaceResourceSetUpdated: () => undefined,
  closeSessionConnections: () => undefined,
  revokeWorkspaceSseAccess: async () => {
    await Promise.resolve(undefined);
  },
} satisfies NonNullable<
  Parameters<typeof removeWorkspaceMemberHandler>[0]["dependencies"]
>;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("member assignment transaction ordering (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests).toBe(true);
    });
  });
} else {
  test("organization removal clears only the departing member's presence and rejoining starts unreported", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const otherOrganizationId = mintAuthProviderId<"organization">();
      const actorUserId = mintAuthProviderId<"user">();
      const userId = mintAuthProviderId<"user">();
      const memberId = Bun.randomUUIDv7();
      const desktopId = Bun.randomUUIDv7();
      const scopedDb = async <T>(run: (tx: Transaction) => Promise<T>) =>
        await db.transaction(
          async (tx) => await run(asTestRaw<Transaction>(tx)),
        );
      await db.insert(user).values(
        [actorUserId, userId].map((id) => ({
          id,
          name: "Presence member",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values(
          [organizationId, otherOrganizationId].map((id) => ({
            id,
            name: "Presence organization",
            slug: id,
            createdAt: new Date(),
          })),
        );
        await db.insert(member).values([
          {
            id: memberId,
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          },
          {
            id: Bun.randomUUIDv7(),
            organizationId,
            userId: actorUserId,
            role: "owner",
            createdAt: new Date(),
          },
          {
            id: Bun.randomUUIDv7(),
            organizationId: otherOrganizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          },
        ]);
        const report = {
          desktopId,
          version: "1.0.0",
          protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
        };
        await Promise.all(
          [
            { organizationId, userId },
            { organizationId, userId: actorUserId },
            { organizationId: otherOrganizationId, userId },
          ].map(
            async (owner) =>
              await reportDesktopPresence({ scopedDb, ...owner, report }),
          ),
        );
        await reportDesktopPresence({
          scopedDb,
          organizationId,
          userId,
          report: { ...report, desktopId: Bun.randomUUIDv7() },
        });
        expect(
          (await readDesktopPresence({ scopedDb, organizationId, userId }))
            .type,
        ).toBe("current");
        await scopedDb(
          async (tx) =>
            await removeOrganizationMemberInTransaction(tx, {
              organizationId,
              memberId,
              userId,
              actorUserId,
            }),
        );
        expect(
          await db.$count(
            desktopPresence,
            and(
              eq(desktopPresence.organizationId, organizationId),
              eq(desktopPresence.userId, userId),
            ),
          ),
        ).toBe(0);
        expect(
          await db.$count(
            desktopPresence,
            eq(desktopPresence.userId, actorUserId),
          ),
        ).toBe(1);
        expect(
          await db.$count(
            desktopPresence,
            eq(desktopPresence.organizationId, otherOrganizationId),
          ),
        ).toBe(1);
        await db.insert(member).values({
          id: Bun.randomUUIDv7(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        });
        expect(
          await readDesktopPresence({ scopedDb, organizationId, userId }),
        ).toEqual({ type: "none" });
        await reportDesktopPresence({
          scopedDb,
          organizationId,
          userId,
          report,
        });
        expect(
          (await readDesktopPresence({ scopedDb, organizationId, userId }))
            .type,
        ).toBe("current");
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db
          .delete(organization)
          .where(eq(organization.id, otherOrganizationId));
        await db.delete(user).where(eq(user.id, userId));
        await db.delete(user).where(eq(user.id, actorUserId));
      }
    });
  });

  for (const kind of [
    "add",
    "move",
    "contact-create",
    "contact-update",
    "membership",
  ] as const) {
    for (const first of ["assignment", "removal"] as const) {
      test(`${kind}: ${first} commits first`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holding = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const attempted = Promise.withResolvers<undefined>();
          const { db: firstDb } = openClient();
          const { db: secondDb } = openClient({
            logger: {
              logQuery: (query) => {
                if (/select.*from "(?:workspaces|member)"/iu.test(query)) {
                  attempted.resolve(undefined);
                }
              },
            },
          });
          const { db: checkDb } = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const actorUserId = mintAuthProviderId<"user">();
          const leaverUserId = mintAuthProviderId<"user">();
          const memberId = Bun.randomUUIDv7();
          const workspaceId = createSafeId<"workspace">();
          const taskId = createSafeId<"entity">();
          const contactId = createSafeId<"contact">();
          const contactWrite =
            kind === "contact-create" || kind === "contact-update";
          const recordAuditEvent = createBackgroundAuditRecorder({
            organizationId,
            workspaceId,
            userId: actorUserId,
            execution: {
              performer: { type: "user", id: actorUserId },
              trigger: { type: "system", source: "assignment_test" },
            },
          });
          await checkDb.insert(user).values(
            [actorUserId, leaverUserId].map((id) => ({
              id,
              name: "Assignment member",
              email: `${id}@example.test`,
            })),
          );
          await checkDb.insert(organization).values({
            id: organizationId,
            name: "Assignment organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          try {
            await checkDb.insert(member).values([
              {
                id: Bun.randomUUIDv7(),
                organizationId,
                userId: actorUserId,
                role: "owner",
                createdAt: new Date(),
              },
              {
                id: memberId,
                organizationId,
                userId: leaverUserId,
                role: "member",
                createdAt: new Date(),
              },
            ]);
            await checkDb.insert(workspaces).values({
              id: workspaceId,
              organizationId,
              name: "Assignment matter",
              reference: workspaceId,
            });
            await checkDb
              .insert(workspaceMembers)
              .values(
                (kind === "membership"
                  ? [actorUserId]
                  : [actorUserId, leaverUserId]
                ).map((userId) => ({ workspaceId, userId })),
              );
            await checkDb.insert(entities).values({
              id: taskId,
              workspaceId,
              kind: "task",
              name: "Assigned task",
            });
            await checkDb.insert(taskAssignees).values({
              entityId: taskId,
              workspaceId,
              userId: actorUserId,
              role: "reviewer",
            });
            if (kind === "contact-update") {
              await checkDb.insert(contacts).values({
                id: contactId,
                organizationId,
                type: "person",
                displayName: "Assignment contact",
                responsibleAttorneyId: actorUserId,
              });
            }
            const safe = (db: GatedTestDb, hold: boolean) =>
              safeDbFromScoped(
                async (fn) =>
                  await db.transaction(async (tx) => {
                    const value = await fn(asTestRaw<Transaction>(tx));
                    if (hold) {
                      holding.resolve(undefined);
                      await release.promise;
                    }
                    return value;
                  }),
              );
            const assignment = async (
              db: GatedTestDb,
              hold: boolean,
            ): Promise<Result<unknown, unknown>> => {
              const safeDb = safe(db, hold);
              if (kind === "membership") {
                return await Result.gen(() =>
                  addWorkspaceMemberHandler({
                    safeDb,
                    organizationId,
                    workspaceId,
                    recordAuditEvent,
                    body: { userId: leaverUserId },
                  }),
                );
              }
              if (kind === "add") {
                return await Result.gen(() =>
                  addAssigneeHandler({
                    safeDb,
                    workspaceId,
                    userId: actorUserId,
                    recordAuditEvent,
                    body: { taskId, userId: leaverUserId },
                  }),
                );
              }
              if (kind === "move") {
                return await Result.gen(() =>
                  moveAssigneeHandler({
                    safeDb,
                    workspaceId,
                    userId: actorUserId,
                    recordAuditEvent,
                    body: {
                      taskId,
                      fromUserId: actorUserId,
                      toUserId: leaverUserId,
                    },
                  }),
                );
              }
              if (kind === "contact-create") {
                return await Result.gen(() =>
                  createContactHandler({
                    safeDb,
                    organizationId,
                    userId: actorUserId,
                    recordAuditEvent,
                    body: {
                      id: contactId,
                      type: "person",
                      displayName: "Assignment contact",
                      originatingAttorneyId: leaverUserId,
                      responsibleAttorneyId: actorUserId,
                    },
                  }),
                );
              }
              return await Result.gen(() =>
                updateContactHandler({
                  safeDb,
                  organizationId,
                  contactId,
                  recordAuditEvent,
                  body: { originatingAttorneyId: leaverUserId },
                }),
              );
            };
            const removal = async (
              db: GatedTestDb,
              hold: boolean,
            ): Promise<Result<unknown, unknown>> => {
              const safeDb = safe(db, hold);
              if (!contactWrite && kind !== "membership") {
                return await Result.gen(() =>
                  removeWorkspaceMemberHandler({
                    safeDb,
                    workspaceId,
                    userId: leaverUserId,
                    actorUserId,
                    recordAuditEvent,
                    dependencies,
                  }),
                );
              }
              return await safeDb(async (tx) => {
                await removeOrganizationMemberInTransaction(tx, {
                  organizationId,
                  memberId,
                  userId: leaverUserId,
                  actorUserId,
                });
                return { success: true };
              });
            };
            const firstOperation =
              first === "assignment" ? assignment : removal;
            const secondOperation =
              first === "assignment" ? removal : assignment;
            const firstResult = firstOperation(firstDb, true);
            await Promise.race([
              holding.promise,
              firstResult.then((result) => {
                if (Result.isError(result)) {
                  throw result.error;
                }
                throw new Error("First operation did not hold its transaction");
              }),
            ]);
            const secondResult = secondOperation(secondDb, false);
            try {
              await Promise.race([
                attempted.promise,
                secondResult.then((result) => {
                  if (Result.isError(result)) {
                    throw result.error;
                  }
                  throw new Error(
                    "Second operation did not reach membership locking",
                  );
                }),
              ]);
            } finally {
              release.resolve(undefined);
            }
            const [earlier, later] = await Promise.all([
              firstResult,
              secondResult,
            ]);
            expect(
              earlier,
              Bun.inspect(earlier, { depth: Infinity }),
            ).toMatchObject({
              status: "ok",
            });
            expect(
              later,
              Bun.inspect(later, { depth: Infinity }),
            ).toMatchObject({
              status: first === "removal" ? "error" : "ok",
            });
            if (first === "removal" && Result.isError(later)) {
              expect(later.error).toMatchObject({
                status: 400,
                message:
                  contactWrite || kind === "membership"
                    ? "User is not a member of this organization"
                    : "User is not a member of this workspace",
              });
            }
            expect(
              await checkDb.$count(entities, eq(entities.id, taskId)),
            ).toBe(1);
            expect(
              await checkDb.$count(
                taskAssignees,
                and(
                  eq(taskAssignees.entityId, taskId),
                  eq(taskAssignees.userId, leaverUserId),
                ),
              ),
            ).toBe(0);
            expect(
              await checkDb.$count(
                workspaceMembers,
                and(
                  eq(workspaceMembers.workspaceId, workspaceId),
                  eq(workspaceMembers.userId, leaverUserId),
                ),
              ),
            ).toBe(0);
            const rows = await checkDb
              .select({
                originatingAttorneyId: contacts.originatingAttorneyId,
                responsibleAttorneyId: contacts.responsibleAttorneyId,
              })
              .from(contacts)
              .where(eq(contacts.id, contactId));
            if (
              contactWrite &&
              !(kind === "contact-create" && first === "removal")
            ) {
              expect(rows).toEqual([
                {
                  originatingAttorneyId: null,
                  responsibleAttorneyId: actorUserId,
                },
              ]);
            } else {
              expect(rows).toEqual([]);
            }
          } finally {
            release.resolve(undefined);
            await checkDb
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await checkDb.delete(user).where(eq(user.id, actorUserId));
            await checkDb.delete(user).where(eq(user.id, leaverUserId));
          }
        });
      });
    }
  }
  for (const holder of ["projection", "writer"] as const) {
    test(`contact cleanup with a held ${holder} transaction`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: holdingDb } = openClient();
        const { db: removalDb } = openClient();
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const organizationId = mintAuthProviderId<"organization">();
        const actorUserId = mintAuthProviderId<"user">();
        const leaverUserId = mintAuthProviderId<"user">();
        const memberId = Bun.randomUUIDv7();
        const contactId = createSafeId<"contact">();
        await db.insert(user).values(
          [actorUserId, leaverUserId].map((id) => ({
            id,
            name: "Contact member",
            email: `${id}@example.test`,
          })),
        );
        await db.insert(organization).values({
          id: organizationId,
          name: "Contact organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        try {
          await db.insert(member).values([
            {
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: actorUserId,
              role: "owner",
              createdAt: new Date(),
            },
            {
              id: memberId,
              organizationId,
              userId: leaverUserId,
              role: "member",
              createdAt: new Date(),
            },
          ]);
          await db.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Contact assignment",
            originatingAttorneyId: leaverUserId,
          });
          const holderResult = Result.tryPromise(
            async () =>
              await holdingDb.transaction(async (tx) => {
                if (holder === "projection") {
                  // The projection insert holds the source contact's FK KEY SHARE.
                  await tx.execute(sql`
                  INSERT INTO contact_search_documents (
                    contact_id, organization_id, contact_type, title, searchable_text, tsv
                  ) VALUES (${contactId}, ${organizationId}, 'person', 'Contact assignment', '', ''::tsvector)
                `);
                } else {
                  await tx
                    .update(contacts)
                    .set({ displayName: "Contact writer" })
                    .where(eq(contacts.id, contactId));
                }
                held.resolve(undefined);
                await release.promise;
              }),
          );
          await Promise.race([
            held.promise,
            holderResult.then((result) => {
              if (Result.isError(result)) {
                throw result.error;
              }
              throw new Error("Contact transaction did not hold its lock");
            }),
          ]);
          try {
            const removalResult = await safeDbFromScoped(
              async (fn) =>
                await removalDb.transaction(
                  async (tx) => await fn(asTestRaw<Transaction>(tx)),
                ),
            )(
              async (tx) =>
                await removeOrganizationMemberInTransaction(tx, {
                  organizationId,
                  memberId,
                  userId: leaverUserId,
                  actorUserId,
                }),
            );
            if (holder === "projection") {
              expect(removalResult).toMatchObject({ status: "ok" });
            } else {
              expect(removalResult).toMatchObject({
                status: "error",
                error: {
                  cause: { status: 409, code: MEMBER_REMOVAL_BUSY_CODE },
                },
              });
            }
            expect(await db.$count(member, eq(member.id, memberId))).toBe(
              holder === "projection" ? 0 : 1,
            );
            const rows = await db
              .select({ originatingAttorneyId: contacts.originatingAttorneyId })
              .from(contacts)
              .where(eq(contacts.id, contactId));
            expect(rows).toEqual([
              {
                originatingAttorneyId:
                  holder === "projection" ? null : leaverUserId,
              },
            ]);
          } finally {
            release.resolve(undefined);
            expect(await holderResult).toMatchObject({ status: "ok" });
          }
        } finally {
          release.resolve(undefined);
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, actorUserId));
          await db.delete(user).where(eq(user.id, leaverUserId));
        }
      });
    });
  }
  test("rejoining starts with current memberships and operation state", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const owner = await signInHuman(
        `removal-owner-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const leaver = await signInHuman(
        `removal-leaver-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const recipient = await signInHuman(
        `removal-recipient-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const auth = getAuth();
      const org = await auth.api.createOrganization({
        body: {
          name: "Removal fixture",
          slug: `removal-${Bun.randomUUIDv7()}`,
        },
        headers: owner.headers(),
      });
      const membership = await auth.api.addMember({
        body: { organizationId: org.id, userId: leaver.userId, role: "admin" },
        headers: owner.headers(),
      });
      const organizationId = brandPersistedOrganizationId(org.id);
      const workspaceId = createSafeId<"workspace">();
      const taskId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const sessionId = createSafeId<"desktopEditSession">();
      const handoffId = createSafeId<"desktopEditHandoff">();
      const signingId = createSafeId<"pdfSigningSession">();
      const definitionId = createSafeId<"flowDefinition">();
      const runId = createSafeId<"flowRun">();
      const connectorId = createSafeId<"mcpConnector">();
      const inviteId = Bun.randomUUIDv7();
      const retainedInviteId = Bun.randomUUIDv7();
      try {
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Removal matter",
          reference: workspaceId,
          leadUserId: leaver.userId,
        });
        await db.insert(workspaceMembers).values(
          [owner.userId, leaver.userId].map((userId) => ({
            workspaceId,
            userId,
          })),
        );
        await db.insert(entities).values({
          id: taskId,
          workspaceId,
          kind: "task",
          name: "Review work",
        });
        await db.insert(taskAssignees).values({
          entityId: taskId,
          workspaceId,
          userId: leaver.userId,
          role: "reviewer",
        });
        await db.insert(workObligations).values({
          entityId: taskId,
          workspaceId,
          ownerUserId: leaver.userId,
          status: "awaiting_acknowledgement",
        });
        await db
          .insert(entityVersions)
          .values({ id: versionId, workspaceId, entityId: taskId });
        const propertyId = createSafeId<"property">();
        await db.insert(properties).values({
          id: propertyId,
          workspaceId,
          name: "Desktop file",
          content: { version: 1, type: "file" },
          tool: { version: 1, type: "manual-input" },
          status: "fresh",
        });
        await db.insert(desktopEditSessions).values({
          id: sessionId,
          workspaceId,
          entityId: taskId,
          propertyId,
          baseVersionId: versionId,
          createdBy: leaver.userId,
          fileType: "docx",
          fileName: "fixture.docx",
          checkpointFileId: createSafeId<"userFile">(),
          sessionTokenHash: "0".repeat(64),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        });
        await db.insert(desktopEditHandoffs).values({
          id: handoffId,
          workspaceId,
          entityId: taskId,
          propertyId,
          createdBy: leaver.userId,
          tokenHash: "1".repeat(64),
          apiBaseUrl: "https://example.test",
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        await db.insert(pdfSigningSessions).values({
          id: signingId,
          workspaceId,
          entityId: taskId,
          propertyId,
          baseVersionId: versionId,
          createdBy: leaver.userId,
          handoffTokenHash: "2".repeat(64),
          handoffExpiresAt: new Date(Date.now() + 3_600_000),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        });
        const steps = [
          {
            kind: "review-gate" as const,
            name: "Review",
            instructions: "Review fixture",
          },
          {
            kind: "create-document" as const,
            name: "Document",
            documentTitle: "Fixture",
          },
        ];
        await db.insert(flowDefinitions).values({
          id: definitionId,
          organizationId,
          name: "Removal flow",
          steps,
          trigger: { type: "manual" },
          createdByUserId: leaver.userId,
        });
        await db.insert(flowRuns).values({
          id: runId,
          workspaceId,
          definitionId,
          definitionSnapshot: { name: "Removal flow", steps },
          status: "awaiting_review",
          triggerSource: { type: "manual", userId: leaver.userId },
        });
        await db.insert(flowRunSteps).values(
          steps.map(({ kind }, index) => ({
            id: createSafeId<"flowRunStep">(),
            workspaceId,
            runId,
            index,
            kind,
            status:
              index === 0 ? ("awaiting_review" as const) : ("pending" as const),
          })),
        );
        await db.insert(mcpConnectors).values({
          id: connectorId,
          organizationId,
          slug: connectorId,
          displayName: "Fixture connector",
          description: "Fixture",
          url: "https://example.test/mcp",
          authType: "oauth2",
        });
        await db.insert(mcpUserConnections).values(
          [owner.userId, leaver.userId].map((userId) => ({
            id: createSafeId<"mcpUserConnection">(),
            organizationId,
            connectorId,
            userId,
            status: "connected" as const,
          })),
        );
        await db.insert(mcpOAuthState).values({
          state: inviteId,
          organizationId,
          connectorId,
          userId: leaver.userId,
          codeVerifier: "fixture",
          redirectUri: "https://example.test/callback",
          resourceUrl: "https://example.test/mcp",
          authorizationServerUrl: "https://example.test",
        });
        await db.insert(sharepointConnections).values(
          [owner.userId, leaver.userId].map((userId) => ({
            id: createSafeId<"sharepointConnection">(),
            organizationId,
            userId,
            accessTokenEncrypted: Buffer.from("fixture"),
            accessTokenIv: Buffer.from("fixture"),
            status: "connected" as const,
          })),
        );
        await db.insert(sharepointOAuthState).values({
          state: inviteId,
          organizationId,
          userId: leaver.userId,
          codeVerifier: "fixture",
          redirectUri: "https://example.test/callback",
        });
        await db.insert(invitation).values([
          {
            id: inviteId,
            organizationId,
            inviterId: leaver.userId,
            email: recipient.email,
            role: "member",
            status: "pending",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          {
            id: retainedInviteId,
            organizationId,
            inviterId: owner.userId,
            email: recipient.email,
            role: "member",
            status: "pending",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ]);
        await auth.api.removeMember({
          body: { organizationId, memberIdOrEmail: membership.id },
          headers: owner.headers(),
        });
        await auth.api.addMember({
          body: { organizationId, userId: leaver.userId, role: "member" },
          headers: owner.headers(),
        });
        expect(
          await db.$count(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, leaver.userId),
            ),
          ),
        ).toBe(0);
        expect(
          await db.$count(taskAssignees, eq(taskAssignees.entityId, taskId)),
        ).toBe(0);
        expect(
          await db
            .select({ lead: workspaces.leadUserId })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId)),
        ).toEqual([{ lead: null }]);
        expect(
          await db
            .select({
              owner: workObligations.ownerUserId,
              status: workObligations.status,
            })
            .from(workObligations)
            .where(eq(workObligations.entityId, taskId)),
        ).toEqual([{ owner: null, status: "unassigned" }]);
        expect(
          await db
            .select({ status: desktopEditSessions.status })
            .from(desktopEditSessions)
            .where(eq(desktopEditSessions.id, sessionId)),
        ).toEqual([{ status: "cancelled" }]);
        // Credential revocation in the same transaction deletes the
        // leaver's handoffs and signing sessions outright.
        expect(
          await db.$count(
            desktopEditHandoffs,
            eq(desktopEditHandoffs.id, handoffId),
          ),
        ).toBe(0);
        expect(
          await db.$count(
            pdfSigningSessions,
            eq(pdfSigningSessions.id, signingId),
          ),
        ).toBe(0);
        // The authorization layer, not only the rows, refuses the matter.
        expect(
          await resolveMemberAuthorization(
            {
              organizationId,
              userId: brandPersistedUserId(leaver.userId),
              workspaceId,
            },
            db,
          ),
        ).toMatchObject({ role: "member", workspace: null });
        expect(
          await db
            .select({ status: flowRuns.status })
            .from(flowRuns)
            .where(eq(flowRuns.id, runId)),
        ).toEqual([{ status: "cancelled" }]);
        const persistedSteps = await db
          .select({
            id: flowRunSteps.id,
            index: flowRunSteps.index,
            status: flowRunSteps.status,
          })
          .from(flowRunSteps)
          .where(eq(flowRunSteps.runId, runId));
        expect(persistedSteps).toHaveLength(steps.length);
        expect(persistedSteps.map(({ status }) => status)).toEqual(
          steps.map(() => "skipped"),
        );
        const runAudit = await db
          .select({ changes: auditLogs.changes, metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceId, runId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.FLOW_RUN),
            ),
          );
        expect(runAudit).toHaveLength(steps.length + 1);
        expect(runAudit).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              changes: { status: { old: "awaiting_review", new: "cancelled" } },
            }),
            ...persistedSteps.map((step) =>
              expect.objectContaining({
                changes: {
                  stepStatus: {
                    old: step.index === 0 ? "awaiting_review" : "pending",
                    new: "skipped",
                  },
                },
                metadata: expect.objectContaining({
                  cause: "membership_removed",
                  stepId: step.id,
                }),
              }),
            ),
          ]),
        );
        await executeFlowStep(
          { runId, stepIndex: 1 },
          new AbortController().signal,
          { admission: testModelAdmission(organizationId), database: db },
        );
        expect(
          await db.$count(entities, eq(entities.workspaceId, workspaceId)),
        ).toBe(1);
        for (const table of [
          mcpUserConnections,
          sharepointConnections,
          mcpOAuthState,
          sharepointOAuthState,
        ]) {
          expect(
            await db.$count(
              table,
              and(
                eq(table.organizationId, organizationId),
                eq(table.userId, leaver.userId),
              ),
            ),
          ).toBe(0);
        }
        expect(
          await db.$count(
            mcpUserConnections,
            and(
              eq(mcpUserConnections.organizationId, organizationId),
              eq(mcpUserConnections.userId, owner.userId),
            ),
          ),
        ).toBe(1);
        expect(
          await db.$count(
            sharepointConnections,
            and(
              eq(sharepointConnections.organizationId, organizationId),
              eq(sharepointConnections.userId, owner.userId),
            ),
          ),
        ).toBe(1);
        const declined = await auth.api.acceptInvitation({
          body: { invitationId: inviteId },
          headers: recipient.headers(),
          asResponse: true,
        });
        expect(declined.status).toBe(400);
        expect(await declined.json()).toMatchObject({
          code: "INVITATION_NOT_FOUND",
        });
        expect(
          await db.$count(
            member,
            and(
              eq(member.organizationId, organizationId),
              eq(member.userId, recipient.userId),
            ),
          ),
        ).toBe(0);
        const accepted = await auth.api.acceptInvitation({
          body: { invitationId: retainedInviteId },
          headers: recipient.headers(),
          asResponse: true,
        });
        expect(accepted.status).toBe(200);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        for (const browser of [owner, leaver, recipient]) {
          await db.delete(user).where(eq(user.id, browser.userId));
        }
      }
    });
  });

  test("matter removal closes current exchanges and preserves other members", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const actorUserId = mintAuthProviderId<"user">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const propertyId = createSafeId<"property">();
      const versionId = createSafeId<"entityVersion">();
      await db.insert(user).values(
        [actorUserId, userId].map((id) => ({
          id,
          name: "Exchange member",
          email: `${id}@example.test`,
        })),
      );
      await db.insert(organization).values({
        id: organizationId,
        name: "Exchange fixture",
        slug: organizationId,
        createdAt: new Date(),
      });
      try {
        await db.insert(member).values(
          [actorUserId, userId].map((id) => ({
            id: Bun.randomUUIDv7(),
            organizationId,
            userId: id,
            role: id === actorUserId ? "owner" : "admin",
            createdAt: new Date(),
          })),
        );
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Exchange matter",
          reference: workspaceId,
        });
        await db
          .insert(workspaceMembers)
          .values(
            [actorUserId, userId].map((id) => ({ workspaceId, userId: id })),
          );
        await db.insert(entities).values({
          id: entityId,
          workspaceId,
          kind: "document",
          name: "Fixture file",
        });
        await db
          .insert(entityVersions)
          .values({ id: versionId, workspaceId, entityId });
        await db.insert(properties).values({
          id: propertyId,
          workspaceId,
          name: "File",
          content: { version: 1, type: "file" },
          tool: { version: 1, type: "manual-input" },
          status: "fresh",
        });
        const future = new Date(Date.now() + 3_600_000);
        await db.insert(desktopEditHandoffs).values(
          [actorUserId, userId].map((id, index) => ({
            id: createSafeId<"desktopEditHandoff">(),
            workspaceId,
            entityId,
            propertyId,
            createdBy: id,
            tokenHash: String(index + 3).repeat(64),
            apiBaseUrl: "https://example.test",
            expiresAt: future,
          })),
        );
        await db.insert(pdfSigningSessions).values(
          [actorUserId, userId].map((id, index) => ({
            id: createSafeId<"pdfSigningSession">(),
            workspaceId,
            entityId,
            propertyId,
            baseVersionId: versionId,
            createdBy: id,
            handoffTokenHash: String(index + 5).repeat(64),
            handoffExpiresAt: future,
            tokenExpiresAt: future,
          })),
        );
        const recordAuditEvent = createBackgroundAuditRecorder({
          organizationId,
          workspaceId,
          userId: actorUserId,
          execution: {
            performer: { type: "user", id: actorUserId },
            trigger: { type: "system", source: "fixture" },
          },
        });
        const safeDb = safeDbFromScoped(
          async (fn) =>
            await db.transaction(
              async (tx) => await fn(asTestRaw<Transaction>(tx)),
            ),
        );
        const removed = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb,
            workspaceId,
            userId,
            actorUserId,
            recordAuditEvent,
            dependencies,
          }),
        );
        expect(Result.isOk(removed)).toBe(true);
        const expired = await db
          .select({ expiresAt: desktopEditHandoffs.expiresAt })
          .from(desktopEditHandoffs)
          .where(eq(desktopEditHandoffs.createdBy, userId));
        expect(expired.at(0)?.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now(),
        );
        expect(
          await db
            .select({ expiresAt: desktopEditHandoffs.expiresAt })
            .from(desktopEditHandoffs)
            .where(eq(desktopEditHandoffs.createdBy, actorUserId)),
        ).toEqual([{ expiresAt: future }]);
        expect(
          await db
            .select({ status: pdfSigningSessions.status })
            .from(pdfSigningSessions)
            .where(eq(pdfSigningSessions.createdBy, userId)),
        ).toEqual([{ status: "cancelled" }]);
        expect(
          await db
            .select({ status: pdfSigningSessions.status })
            .from(pdfSigningSessions)
            .where(eq(pdfSigningSessions.createdBy, actorUserId)),
        ).toEqual([{ status: "open" }]);
        const signingAudit = await db
          .select({ changes: auditLogs.changes })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, workspaceId),
              eq(
                auditLogs.resourceType,
                AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
              ),
            ),
          );
        expect(signingAudit).toEqual([
          { changes: { status: { old: "open", new: "cancelled" } } },
        ]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, actorUserId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
  for (const lockedRow of ["workspace", "contact"] as const) {
    test(`${lockedRow} contention returns an atomic retryable refusal`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: holdingDb } = openClient();
        const { db: removalDb } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const actorUserId = mintAuthProviderId<"user">();
        const userId = mintAuthProviderId<"user">();
        const memberId = Bun.randomUUIDv7();
        const workspaceId = createSafeId<"workspace">();
        const contactId = createSafeId<"contact">();
        const taskId = createSafeId<"entity">();
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        await holdingDb.insert(user).values(
          [actorUserId, userId].map((id) => ({
            id,
            name: "Busy member",
            email: `${id}@example.test`,
          })),
        );
        await holdingDb.insert(organization).values({
          id: organizationId,
          name: "Busy fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        let writer: Promise<void> | undefined;
        try {
          await holdingDb.insert(member).values([
            {
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: actorUserId,
              role: "owner",
              createdAt: new Date(),
            },
            {
              id: memberId,
              organizationId,
              userId,
              role: "member",
              createdAt: new Date(),
            },
          ]);
          await holdingDb.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Busy matter",
            reference: workspaceId,
          });
          await holdingDb
            .insert(workspaceMembers)
            .values({ workspaceId, userId });
          await holdingDb.insert(entities).values({
            id: taskId,
            workspaceId,
            kind: "task",
            name: "Busy task",
          });
          await holdingDb.insert(taskAssignees).values({
            entityId: taskId,
            workspaceId,
            userId,
            role: "assignee",
          });
          await holdingDb.insert(contacts).values({
            id: contactId,
            organizationId,
            type: "person",
            displayName: "Busy contact",
            responsibleAttorneyId: userId,
          });
          writer = holdingDb.transaction(async (tx) => {
            if (lockedRow === "workspace") {
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .for("update");
            } else {
              await tx
                .select({ id: contacts.id })
                .from(contacts)
                .where(eq(contacts.id, contactId))
                .for("update");
            }
            held.resolve(undefined);
            await release.promise;
          });
          await held.promise;
          const refused = await Result.tryPromise({
            try: async () =>
              await removalDb.transaction(async (tx) => {
                if (lockedRow === "workspace") {
                  await tx
                    .select({ id: member.id })
                    .from(member)
                    .where(eq(member.id, memberId))
                    .for("update");
                  await tryLockMemberCleanupWorkspace(
                    asTestRaw<Transaction>(tx),
                    workspaceId,
                  );
                } else {
                  await removeOrganizationMemberInTransaction(
                    asTestRaw<Transaction>(tx),
                    {
                      organizationId,
                      memberId,
                      userId,
                      actorUserId,
                    },
                  );
                }
              }),
            catch: (error) => error,
          });
          expect(Result.isError(refused)).toBe(true);
          if (Result.isError(refused)) {
            expect(refused.error).toMatchObject({
              status: 409,
              code: "member_removal_busy",
              retryable: true,
            });
          }
          release.resolve(undefined);
          await writer;
          expect(
            await holdingDb.$count(
              workspaceMembers,
              eq(workspaceMembers.userId, userId),
            ),
          ).toBe(1);
          expect(
            await holdingDb.$count(
              taskAssignees,
              eq(taskAssignees.userId, userId),
            ),
          ).toBe(1);
          expect(await holdingDb.$count(member, eq(member.id, memberId))).toBe(
            1,
          );
        } finally {
          release.resolve(undefined);
          if (writer) {
            await writer;
          }
          await holdingDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await holdingDb.delete(user).where(eq(user.id, actorUserId));
          await holdingDb.delete(user).where(eq(user.id, userId));
        }
      });
    });
  }
}
