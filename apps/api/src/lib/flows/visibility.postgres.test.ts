import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  entities,
  entityLinks,
  featureEnrolments,
  notifications,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";

import {
  flowNotificationVisibilityCondition,
  flowRelatedTaskVisibilityConditions,
  flowReviewTaskVisibilityCondition,
} from "./visibility";

const testState = createTestState({ file: import.meta.path, config: env });

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
if (!databaseUrl || !enabled) {
  describe.skip("flow visibility at query execution", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("predicates constructed before opt-out hide linked reads and preserve unread outcomes until regrant", async () => {
    const previous = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        try {
          const ordinaryId = createSafeId<"entity">();
          const secondOrdinaryId = createSafeId<"entity">();
          await db.insert(entities).values([
            {
              id: ordinaryId,
              workspaceId: fixture.workspaceId,
              kind: "task",
              name: "Ordinary task",
            },
            {
              id: secondOrdinaryId,
              workspaceId: fixture.workspaceId,
              kind: "task",
              name: "Another ordinary task",
            },
          ]);
          const linkedId = createSafeId<"entityLink">();
          const ordinaryLinkId = createSafeId<"entityLink">();
          await db.insert(entityLinks).values([
            {
              id: linkedId,
              workspaceId: fixture.workspaceId,
              sourceEntityId: ordinaryId,
              targetEntityId: fixture.taskEntityId,
              linkType: "related",
            },
            {
              id: ordinaryLinkId,
              workspaceId: fixture.workspaceId,
              sourceEntityId: ordinaryId,
              targetEntityId: secondOrdinaryId,
              linkType: "related",
            },
          ]);
          const flowId = createSafeId<"notification">();
          const mentionId = createSafeId<"notification">();
          const sharedId = createSafeId<"notification">();
          await db.insert(notifications).values([
            {
              id: flowId,
              idempotencyKey: flowId,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
              metadata: { flowName: "Review flow" },
              entityType: "flow_run",
              entityId: fixture.runId,
            },
            {
              id: mentionId,
              idempotencyKey: mentionId,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              kind: NOTIFICATION_KIND.MENTION,
              metadata: { actorName: "Reviewer" },
              entityType: "entity",
              entityId: fixture.taskEntityId,
            },
            {
              id: sharedId,
              idempotencyKey: sharedId,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              kind: NOTIFICATION_KIND.MENTION,
              metadata: { actorName: "Reviewer" },
              entityType: "entity",
              entityId: ordinaryId,
            },
          ]);
          // These exact predicates are reused across revoke and regrant; no new preflight runs.
          const options = {
            organizationId: fixture.organizationId,
            userId: fixture.userId,
          };
          const review = flowReviewTaskVisibilityCondition(options);
          const related = flowRelatedTaskVisibilityConditions(options);
          const notification = flowNotificationVisibilityCondition(options);
          const readTasks = async () =>
            (
              await db
                .select({ id: entities.id })
                .from(entities)
                .where(
                  and(eq(entities.workspaceId, fixture.workspaceId), review),
                )
            )
              .map(({ id }) => id)
              .toSorted();
          const readRelated = async () =>
            (
              await db
                .select({ id: entities.id })
                .from(entities)
                .where(
                  and(
                    eq(entities.workspaceId, fixture.workspaceId),
                    related.entity(entities),
                  ),
                )
            )
              .map(({ id }) => id)
              .toSorted();
          const readLinks = async () =>
            (
              await db
                .select({ id: entityLinks.id })
                .from(entityLinks)
                .where(
                  and(
                    eq(entityLinks.workspaceId, fixture.workspaceId),
                    related.link(entityLinks),
                  ),
                )
            )
              .map(({ id }) => id)
              .toSorted();
          const readNotifications = async () =>
            (
              await db
                .select({ id: notifications.id })
                .from(notifications)
                .where(
                  and(eq(notifications.userId, fixture.userId), notification),
                )
            )
              .map(({ id }) => id)
              .toSorted();
          expect(await readTasks()).toContain(fixture.taskEntityId);
          expect(await readNotifications()).toEqual(
            [flowId, mentionId, sharedId].toSorted(),
          );
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, fixture.organizationId),
                  eq(featureEnrolments.userId, fixture.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
          });
          const ordinary = [ordinaryId, secondOrdinaryId].toSorted();
          expect(await readTasks()).toEqual(ordinary);
          expect(await readRelated()).toEqual(ordinary);
          expect(await readLinks()).toEqual([ordinaryLinkId]);
          expect(await readNotifications()).toEqual([sharedId]);
          const marked = await db
            .update(notifications)
            .set({ readAt: new Date() })
            .where(
              and(
                eq(notifications.userId, fixture.userId),
                isNull(notifications.readAt),
                notification,
              ),
            )
            .returning({ id: notifications.id });
          expect(marked.map(({ id }) => id)).toEqual([sharedId]);
          const retained = await db
            .select({ id: notifications.id, readAt: notifications.readAt })
            .from(notifications)
            .where(eq(notifications.userId, fixture.userId));
          expect(
            retained
              .filter(({ id }) => id !== sharedId)
              .map(({ readAt }) => readAt),
          ).toEqual([null, null]);
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx
              .insert(featureEnrolments)
              .values({ ...options, featureId: "flows" });
          });
          expect(await readTasks()).toContain(fixture.taskEntityId);
          expect(await readRelated()).toContain(fixture.taskEntityId);
          expect(await readLinks()).toEqual(
            [linkedId, ordinaryLinkId].toSorted(),
          );
          expect(await readNotifications()).toEqual(
            [flowId, mentionId, sharedId].toSorted(),
          );
        } finally {
          await fixture.cleanup();
        }
      });
    } finally {
      testState.setConfig("FEATURE_FLOWS", previous);
      restore();
    }
  });
}
