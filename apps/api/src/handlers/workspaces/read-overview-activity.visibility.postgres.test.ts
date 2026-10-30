import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { RUNTIME_MODE } from "@stll/runtime-mode";
import { createTestState } from "@stll/test-state";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  featureEnrolments,
  notifications,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import exportAuditLogs from "@/api/handlers/audit-logs/export";
import { queryAuditLogPage } from "@/api/handlers/audit-logs/query";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { loadTimeSuggestions } from "@/api/handlers/time-entries/suggestions/load";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { executeFlowStep } from "@/api/lib/flows/flow-executor";
import { flowNotificationVisibilityCondition } from "@/api/lib/flows/visibility";
import { createNotificationsInTransaction } from "@/api/lib/notifications";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { visibleActivityCondition } from "./read-overview-activity.visibility";

const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("overview activity flow admission", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("worker-created review activity remains gated through real handler deletion", async () => {
    const previous = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
          taskSetup: "worker",
        });
        const unenrolledUserId = mintAuthProviderId<"user">();
        try {
          await db.insert(user).values({
            id: unenrolledUserId,
            name: "Matter member",
            email: `${unenrolledUserId}@example.test`,
            emailVerified: true,
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: fixture.organizationId,
            userId: unenrolledUserId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(workspaceMembers).values({
            workspaceId: fixture.workspaceId,
            userId: unenrolledUserId,
          });
          const scoped = createScopedDb(
            markRlsDatabase(db),
            [fixture.workspaceId],
            fixture.organizationId,
            fixture.userId,
          );
          await executeFlowStep(
            { runId: fixture.runId, stepIndex: 0 },
            new AbortController().signal,
            {
              admission: testModelAdmission(fixture.organizationId),
              database: db,
              makeScopedDb: () => scoped,
              makeSafeDb: () => fixture.safeDb(db),
              broadcastUpdate: () => undefined,
              enqueueStep: async () => undefined,
              taskFeatures: { governedWorkflow: false, legalLists: false },
            },
          );
          const taskId = (await fixture.read()).steps.at(0)?.reviewTaskEntityId;
          expect(taskId).toBeDefined();
          if (!taskId) {
            panic("Worker did not create a review task");
          }
          expect(
            await db.query.entities.findFirst({
              where: { id: { eq: taskId } },
            }),
          ).toMatchObject({ featureOwner: "flows" });
          const activity = async (userId: typeof fixture.userId) =>
            await db
              .select({ action: auditLogs.action })
              .from(auditLogs)
              .where(
                and(
                  eq(auditLogs.workspaceId, fixture.workspaceId),
                  eq(auditLogs.resourceId, taskId),
                  visibleActivityCondition({
                    organizationId: fixture.organizationId,
                    userId,
                  }),
                ),
              );
          expect(await activity(fixture.userId)).toContainEqual({
            action: AUDIT_ACTION.CREATE,
          });
          expect(await activity(unenrolledUserId)).toEqual([]);
          const pings = await db.transaction(
            async (tx) =>
              await createNotificationsInTransaction(
                [
                  {
                    kind: NOTIFICATION_KIND.MENTION,
                    metadata: { actorName: "Reviewer" },
                    userId: unenrolledUserId,
                    organizationId: fixture.organizationId,
                    workspaceId: fixture.workspaceId,
                    entityType: "entity",
                    entityId: taskId,
                    idempotencyKey: createSafeId<"notification">(),
                  },
                ],
                tx,
              ),
          );
          expect(pings).toEqual([]);
          expect(
            (await fixture.act(fixture.safeDb(db), "approved")).isOk(),
          ).toBe(true);
          const removed = await Result.gen(async function* () {
            return yield* deleteEntitiesHandler({
              safeDb: fixture.safeDb(db),
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              recordAuditEvent: fixture.recordAuditEvent,
              enqueueCleanup: async () => undefined,
              body: { entityIds: [taskId] },
            });
          });
          expect(removed.isOk()).toBe(true);
          expect(
            await db.query.entities.findFirst({
              where: { id: { eq: taskId } },
            }),
          ).toBeUndefined();
          expect(await activity(unenrolledUserId)).toEqual([]);
          expect(await activity(fixture.userId)).toEqual(
            expect.arrayContaining([
              { action: AUDIT_ACTION.CREATE },
              { action: AUDIT_ACTION.DELETE },
            ]),
          );
          await db
            .update(member)
            .set({ role: "admin" })
            .where(
              and(
                eq(member.organizationId, fixture.organizationId),
                eq(member.userId, unenrolledUserId),
              ),
            );
          const ordinaryId = createSafeId<"entity">();
          await db.insert(entities).values({
            id: ordinaryId,
            workspaceId: fixture.workspaceId,
            kind: "task",
            featureOwner: "shared",
            name: "Ordinary task",
          });
          await fixture.recordAuditEvent(asTestRaw<Transaction>(db), {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: ordinaryId,
            metadata: { kind: "task" },
          });
          const adminDb = createSafeDb(
            markRlsDatabase(db),
            [fixture.workspaceId],
            fixture.organizationId,
            unenrolledUserId,
          );
          const adminRecorder = createBackgroundAuditRecorder({
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            userId: unenrolledUserId,
            execution: {
              performer: { type: "user", id: unenrolledUserId },
              trigger: { type: "direct" },
            },
          });
          const page = await Result.gen(() =>
            queryAuditLogPage({
              safeDb: adminDb,
              organizationId: fixture.organizationId,
              userId: unenrolledUserId,
              featureAccessSnapshot: undefined,
              recordAuditEvent: adminRecorder,
              query: {
                workspaceId: fixture.workspaceId,
                resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              },
            }),
          );
          const resourceIds = page
            .unwrap()
            .items.map(({ resourceId }) => resourceId);
          expect(resourceIds).toContain(ordinaryId);
          expect(resourceIds).not.toContain(taskId);
          const csv = await exportAuditLogs.handler(
            asTestRaw<Parameters<typeof exportAuditLogs.handler>[0]>({
              memberRole: sessionMemberRole("admin"),
              query: {
                workspaceId: fixture.workspaceId,
                resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              },
              recordAuditEvent: adminRecorder,
              request: new Request("http://localhost/v1/audit-logs/export"),
              route: "/v1/audit-logs/export",
              safeDb: adminDb,
              session: { activeOrganizationId: fixture.organizationId },
              set: { headers: {} },
              user: { id: unenrolledUserId },
            }),
          );
          expect(typeof csv).toBe("string");
          expect(csv).toContain(ordinaryId);
          expect(csv).not.toContain(taskId);
          const suggestions = async () => {
            const loaded = await Result.gen(async function* () {
              const loadedSuggestions = yield* loadTimeSuggestions({
                safeDb: fixture.safeDb(db),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                userId: fixture.userId,
                featureAccessSnapshot: undefined,
                date: new Date().toISOString().slice(0, 10),
                timezoneId: "UTC",
              });
              return Result.ok(loadedSuggestions);
            });
            return loaded.unwrap().pending.flatMap(({ evidence }) => evidence);
          };
          expect(await suggestions()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "resource", id: taskId }),
            ]),
          );
          await db
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, fixture.organizationId),
                eq(featureEnrolments.userId, fixture.userId),
                eq(featureEnrolments.featureId, "flows"),
              ),
            );
          expect(await suggestions()).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "resource", id: taskId }),
            ]),
          );
        } finally {
          await fixture.cleanup();
          await db.delete(user).where(eq(user.id, unenrolledUserId));
        }
      });
    } finally {
      testState.setConfig("FEATURE_FLOWS", previous);
      restore();
    }
  });
  test("retained activity and mentions follow their owning feature before pagination", async () => {
    const previous = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const unenrolledUserId = mintAuthProviderId<"user">();
        try {
          await db.insert(user).values({
            id: unenrolledUserId,
            name: "Matter member",
            email: `${unenrolledUserId}@example.test`,
            emailVerified: true,
          });
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: fixture.organizationId,
            userId: unenrolledUserId,
            role: "member",
            createdAt: new Date(),
          });
          await db.insert(workspaceMembers).values({
            workspaceId: fixture.workspaceId,
            userId: unenrolledUserId,
          });

          const recorder = createBackgroundAuditRecorder({
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            execution: {
              performer: { type: "user", id: fixture.userId },
              trigger: { type: "direct" },
            },
          });
          const versionId = createSafeId<"entityVersion">();
          await recorder(asTestRaw<Transaction>(db), [
            {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.FIELD,
              resourceId: `${versionId}:${createSafeId<"property">()}`,
              metadata: { entityId: fixture.taskEntityId, kind: "task" },
            },
            {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
              resourceId: versionId,
              metadata: { entityId: fixture.taskEntityId, kind: "task" },
            },
          ]);
          const ordinaryIds = Array.from({ length: 3 }, () =>
            createSafeId<"entity">(),
          );
          await db.insert(entities).values(
            ordinaryIds.map((id) => ({
              id,
              workspaceId: fixture.workspaceId,
              kind: "task" as const,
              featureOwner: "shared" as const,
              name: "Ordinary task",
            })),
          );
          for (const id of ordinaryIds) {
            await recorder(asTestRaw<Transaction>(db), {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              resourceId: id,
              metadata: { kind: "task" },
            });
          }
          const mentionId = createSafeId<"notification">();
          await db.transaction(async (tx) => {
            await createNotificationsInTransaction(
              [
                {
                  kind: NOTIFICATION_KIND.MENTION,
                  metadata: { actorName: "Reviewer" },
                  userId: unenrolledUserId,
                  organizationId: fixture.organizationId,
                  workspaceId: fixture.workspaceId,
                  entityType: "entity",
                  entityId: fixture.taskEntityId,
                  idempotencyKey: mentionId,
                },
              ],
              tx,
            );
          });

          const visibleAuditIds = async (
            userId: typeof fixture.userId,
            limit = 3,
          ) =>
            await db
              .select({
                id: auditLogs.id,
                resourceType: auditLogs.resourceType,
              })
              .from(auditLogs)
              .where(
                and(
                  eq(auditLogs.workspaceId, fixture.workspaceId),
                  visibleActivityCondition({
                    organizationId: fixture.organizationId,
                    userId,
                  }),
                ),
              )
              .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
              .limit(limit);
          const visibleNotifications = async (userId: typeof fixture.userId) =>
            await db
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.userId, unenrolledUserId),
                  flowNotificationVisibilityCondition({
                    organizationId: fixture.organizationId,
                    userId,
                  }),
                ),
              );

          expect(await visibleAuditIds(fixture.userId, 20)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ resourceType: "field" }),
              expect.objectContaining({ resourceType: "entity_version" }),
            ]),
          );
          const unenrolled = await visibleAuditIds(unenrolledUserId);
          expect(unenrolled).toHaveLength(3);
          expect(
            unenrolled.map(({ resourceType }) => resourceType),
          ).not.toContain("field");
          expect(
            unenrolled.map(({ resourceType }) => resourceType),
          ).not.toContain("entity_version");
          expect(await visibleNotifications(unenrolledUserId)).toHaveLength(0);
        } finally {
          await db
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, fixture.organizationId),
                inArray(featureEnrolments.userId, [unenrolledUserId]),
              ),
            );
          await fixture.cleanup();
          await db.delete(user).where(eq(user.id, unenrolledUserId));
        }
      });
    } finally {
      testState.setConfig("FEATURE_FLOWS", previous);
      restore();
    }
  });
}
