import { describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  featureEnrolments,
  notifications,
  workspaceMembers,
} from "@/api/db/schema";
import { env } from "@/api/env";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { flowNotificationVisibilityCondition } from "@/api/lib/flows/visibility";
import { createNotificationsInTransaction } from "@/api/lib/notifications";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";
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

          await db
            .delete(entities)
            .where(eq(entities.id, fixture.taskEntityId));
          expect(await visibleAuditIds(unenrolledUserId)).toHaveLength(3);
          expect(await visibleNotifications(unenrolledUserId)).toHaveLength(0);
          expect(await visibleNotifications(fixture.userId)).toEqual([
            { id: mentionId },
          ]);
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
