import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  auditLogs,
  entities,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceSetUpdated } from "@/api/lib/resource-realtime";
import { ensureActiveWorkspace } from "@/api/mcp/tool-utils";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { removeWorkspaceMemberHandler } from "./workspace-members-remove";

const pushSessionEventMock = mock(() => undefined);
const closeSessionConnectionsMock = mock(() => undefined);
const broadcastMock = mock(() => undefined);
const revokeWorkspaceSseAccessMock = mock(async () => undefined);
const dependencies = {
  broadcastWorkspaceResourceSetUpdated: (workspaceId, resourceType) =>
    broadcastWorkspaceResourceSetUpdated(
      workspaceId,
      resourceType,
      broadcastMock,
    ),
  closeSessionConnections: closeSessionConnectionsMock,
  pushSessionEvent: pushSessionEventMock,
  revokeWorkspaceSseAccess: revokeWorkspaceSseAccessMock,
} satisfies NonNullable<
  Parameters<typeof removeWorkspaceMemberHandler>[0]["dependencies"]
>;

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("removeWorkspaceMemberHandler RLS integration", () => {
  test("a global-chat pin preserves self-removal cleanup and audit scope", async () => {
    try {
      await testDb.transaction(async (outerTx) => {
        await outerTx
          .update(workspaces)
          .set({ leadUserId: ids.userA1 })
          .where(eq(workspaces.id, ids.wsA2));

        const rlsTx = markRlsDatabase(outerTx);
        const serverValidatedWorkspaceIds: TestIds["wsA2"][] = [];
        const databaseIdentity = {
          organizationId: ids.orgA,
          serverValidatedWorkspaceIds,
          userId: ids.userA1,
        };
        // PGlite and Bun SQL differ only in their erased driver result type;
        // the handler exercises the same SafeDb callback contract at runtime.
        const safeDb = asTestRaw<SafeDb>(
          createMembershipSafeDb(rlsTx, databaseIdentity),
        );
        const recordAuditEvent = createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA1,
          request: new Request(
            `https://api.example.test/v1/workspaces/${ids.wsA2}/members/${ids.userA1}`,
          ),
          server: null,
        });

        const scopedDb = asTestRaw<ScopedDb>(
          createMembershipScopedDb(rlsTx, databaseIdentity),
        );
        const authorizedChatWorkspaceIds = new Set([ids.wsA2]);
        const context = buildMcpContextFromChat({
          memberRole: "owner",
          organizationId: ids.orgA,
          pinServerValidatedWorkspaceId: (workspaceId) => {
            if (!authorizedChatWorkspaceIds.has(workspaceId)) {
              return false;
            }
            if (!serverValidatedWorkspaceIds.includes(workspaceId)) {
              serverValidatedWorkspaceIds.push(workspaceId);
            }
            return true;
          },
          recordAuditEvent,
          safeDb,
          scopedDb,
          toolWorkspaceIds: resolveToolWorkspaceIds({
            accessibleWorkspaceIds: [ids.wsA2],
            pinnedIds: [],
          }),
          userId: ids.userA1,
          workspaceStatusById: new Map([[ids.wsA2, "active"]]),
        });
        const workspaceId = ensureActiveWorkspace({
          context,
          workspaceId: ids.wsA2,
        });
        if (typeof workspaceId !== "string") {
          throw new TypeError(
            "Expected global-chat workspace access to be pinned",
          );
        }
        expect(serverValidatedWorkspaceIds).toEqual([ids.wsA2]);

        const result = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb: context.safeDb,
            workspaceId,
            userId: ids.userA1,
            actorUserId: ids.userA1,
            recordAuditEvent,
            dependencies,
          }),
        );

        expect(result).toEqual(Result.ok({ id: ids.memberA1wsA2 }));

        const visibleWorkspaceIds = await context.scopedDb((tx) =>
          tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(inArray(workspaces.id, [ids.wsA2, ids.wsB1])),
        );
        expect(visibleWorkspaceIds).toEqual([{ id: ids.wsA2 }]);

        // Nested scoped transactions leave their SET LOCAL role active in the
        // outer transaction. Restore the root role for state verification.
        await outerTx.execute(sql`RESET ROLE`);

        const remainingMemberships = await outerTx.$count(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, ids.wsA2),
            eq(workspaceMembers.userId, ids.userA1),
          ),
        );
        expect(remainingMemberships).toBe(0);

        const workspace = await outerTx
          .select({ leadUserId: workspaces.leadUserId })
          .from(workspaces)
          .where(eq(workspaces.id, ids.wsA2))
          .then((rows) => rows.at(0));
        expect(workspace).toEqual({ leadUserId: null });

        const auditRows = await outerTx
          .select({
            action: auditLogs.action,
            changes: auditLogs.changes,
            metadata: auditLogs.metadata,
            resourceId: auditLogs.resourceId,
            resourceType: auditLogs.resourceType,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, ids.orgA),
              inArray(auditLogs.resourceId, [ids.memberA1wsA2, ids.wsA2]),
            ),
          );
        expect(auditRows).toHaveLength(2);
        expect(auditRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: "delete",
              changes: {
                deleted: {
                  old: { userId: ids.userA1, workspaceId: ids.wsA2 },
                  new: null,
                },
              },
              metadata: expect.objectContaining({
                closedDesktopEditSessions: 0,
              }),
              resourceId: ids.memberA1wsA2,
              resourceType: "workspace_member",
            }),
            expect.objectContaining({
              action: "update",
              changes: {
                leadUserId: { old: ids.userA1, new: null },
              },
              resourceId: ids.wsA2,
              resourceType: "workspace",
            }),
          ]),
        );
        expect(pushSessionEventMock).not.toHaveBeenCalled();
        expect(closeSessionConnectionsMock).not.toHaveBeenCalled();
        expect(broadcastMock).not.toHaveBeenCalled();
        expect(revokeWorkspaceSseAccessMock).toHaveBeenCalledWith(
          ids.wsA2,
          ids.userA1,
        );

        outerTx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }

    throw new Error("Expected the integration test transaction to roll back");
  });

  test("the synchronous cap excludes closed ownership history", async () => {
    try {
      await testDb.transaction(async (outerTx) => {
        const closedEntityIds = Array.from(
          {
            length: LIMITS.workspaceMemberRemovalWorkObligationsMax + 1,
          },
          () => createSafeId<"entity">(),
        );
        const mutableEntityId = createSafeId<"entity">();
        await outerTx.insert(entities).values([
          ...closedEntityIds.map((id) => ({
            id,
            workspaceId: ids.wsA2,
            kind: "task" as const,
            name: `Closed ownership ${id}`,
            status: "completed",
          })),
          {
            id: mutableEntityId,
            workspaceId: ids.wsA2,
            kind: "task" as const,
            name: "Mutable ownership",
            status: "open",
          },
        ]);
        await outerTx.insert(workObligations).values([
          ...closedEntityIds.map((entityId) => ({
            entityId,
            workspaceId: ids.wsA2,
            ownerUserId: ids.userA1,
            status: WORK_OBLIGATION_STATUS.COMPLETED,
          })),
          {
            entityId: mutableEntityId,
            workspaceId: ids.wsA2,
            ownerUserId: ids.userA1,
            status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          },
        ]);

        const rlsTx = markRlsDatabase(outerTx);
        const databaseIdentity = {
          organizationId: ids.orgA,
          serverValidatedWorkspaceIds: [ids.wsA2],
          userId: ids.userA2,
        };
        const safeDb = asTestRaw<SafeDb>(
          createMembershipSafeDb(rlsTx, databaseIdentity),
        );
        const recordAuditEvent = createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA2,
          request: new Request(
            `https://api.example.test/v1/workspaces/${ids.wsA2}/members/${ids.userA1}`,
          ),
          server: null,
        });

        const result = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb,
            workspaceId: ids.wsA2,
            userId: ids.userA1,
            actorUserId: ids.userA2,
            recordAuditEvent,
            dependencies,
          }),
        );
        expect(result).toEqual(Result.ok({ id: ids.memberA1wsA2 }));

        await outerTx.execute(sql`RESET ROLE`);
        expect(
          await outerTx
            .select({
              ownerUserId: workObligations.ownerUserId,
              status: workObligations.status,
            })
            .from(workObligations)
            .where(eq(workObligations.entityId, mutableEntityId)),
        ).toEqual([
          {
            ownerUserId: null,
            status: WORK_OBLIGATION_STATUS.UNASSIGNED,
          },
        ]);
        expect(
          await outerTx.$count(
            workObligations,
            and(
              inArray(workObligations.entityId, closedEntityIds),
              eq(workObligations.ownerUserId, ids.userA1),
              eq(workObligations.status, WORK_OBLIGATION_STATUS.COMPLETED),
            ),
          ),
        ).toBe(closedEntityIds.length);
        expect(
          await outerTx.$count(
            workObligationEvents,
            inArray(workObligationEvents.obligationEntityId, [
              ...closedEntityIds,
              mutableEntityId,
            ]),
          ),
        ).toBe(1);

        outerTx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }

    throw new Error("Expected the integration test transaction to roll back");
  });
});
