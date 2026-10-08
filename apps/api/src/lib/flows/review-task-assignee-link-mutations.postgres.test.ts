import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, user } from "@/api/db/auth-schema";
import {
  entities,
  entityLinks,
  featureEnrolments,
  taskAssignees,
  workspaceMembers,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { addAssigneeHandler } from "@/api/handlers/tasks/assignees/add";
import { moveAssigneeHandler } from "@/api/handlers/tasks/assignees/move";
import { removeAssigneeHandler } from "@/api/handlers/tasks/assignees/remove";
import { createEntityLinkHandler } from "@/api/handlers/tasks/entity-links/create";
import { deleteEntityLinkHandler } from "@/api/handlers/tasks/entity-links/delete";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

type SeedMutationTargetsOptions = {
  db: Parameters<typeof flowReviewGateFixture>[0];
  fixture: Awaited<ReturnType<typeof flowReviewGateFixture>>;
  assigneeId: SafeId<"user">;
};

const seedMutationTargets = async ({
  db,
  fixture,
  assigneeId,
}: SeedMutationTargetsOptions) => {
  await db.insert(user).values({
    id: assigneeId,
    name: "Assignee",
    email: `${assigneeId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: fixture.organizationId,
    userId: assigneeId,
    role: "member",
    createdAt: new Date(),
  });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: fixture.workspaceId, userId: assigneeId });
  await db.insert(featureEnrolments).values({
    organizationId: fixture.organizationId,
    userId: assigneeId,
    featureId: "flows",
  });
  const ordinaryId = createSafeId<"entity">();
  const otherId = createSafeId<"entity">();
  await db.insert(entities).values(
    [ordinaryId, otherId].map((id) => ({
      id,
      workspaceId: fixture.workspaceId,
      kind: "task" as const,
      name: "Ordinary task",
      status: "open",
    })),
  );
  const retainedLinkId = createSafeId<"entityLink">();
  await db.insert(entityLinks).values({
    id: retainedLinkId,
    workspaceId: fixture.workspaceId,
    sourceEntityId: ordinaryId,
    targetEntityId: fixture.taskEntityId,
    linkType: "related",
  });
  await db.insert(taskAssignees).values({
    id: createSafeId<"taskAssignee">(),
    workspaceId: fixture.workspaceId,
    entityId: fixture.taskEntityId,
    userId: fixture.userId,
    role: "assignee",
  });
  return { ordinaryId, otherId, retainedLinkId };
};

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true") {
  describe.skip("review-task assignment and link mutations", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("acting-user admission fences every assignee and link operation while ordinary tasks remain writable", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const assigneeId = mintAuthProviderId<"user">();
        try {
          const { ordinaryId, otherId, retainedLinkId } =
            await seedMutationTargets({ db, fixture, assigneeId });
          const scope = {
            safeDb: fixture.safeDb(db),
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            recordAuditEvent: fixture.recordAuditEvent,
          };
          const targets = ({
            sourceId,
            targetId,
          }: {
            sourceId: SafeId<"entity">;
            targetId: SafeId<"entity">;
          }) => ({
            source: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: sourceId }),
            target: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: targetId }),
          });
          const actions = [
            () =>
              Result.gen(() =>
                addAssigneeHandler({
                  ...scope,
                  body: { taskId: fixture.taskEntityId, userId: assigneeId },
                }),
              ),
            () =>
              Result.gen(() =>
                removeAssigneeHandler({
                  ...scope,
                  body: {
                    taskId: fixture.taskEntityId,
                    userId: fixture.userId,
                  },
                }),
              ),
            () =>
              Result.gen(() =>
                moveAssigneeHandler({
                  ...scope,
                  body: {
                    taskId: fixture.taskEntityId,
                    fromUserId: fixture.userId,
                    toUserId: assigneeId,
                  },
                }),
              ),
            () =>
              Result.gen(() =>
                createEntityLinkHandler({
                  ...scope,
                  body: targets({
                    sourceId: otherId,
                    targetId: fixture.taskEntityId,
                  }),
                }),
              ),
            () =>
              Result.gen(() =>
                deleteEntityLinkHandler({
                  ...scope,
                  body: { linkId: retainedLinkId },
                }),
              ),
          ];
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
          // A retained read-only gate must still be hidden before persisted
          // validation errors; the assigned destination remains enrolled.
          await db
            .update(entities)
            .set({ readOnly: true })
            .where(eq(entities.id, fixture.taskEntityId));
          for (const act of actions) {
            // db-await-in-loop: each distinct real mutation owner must refuse without effects.
            const result = await act();
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(result.error).toMatchObject({
                status: 404,
                message: "Not found",
              });
            }
          }
          expect(
            await db.$count(
              taskAssignees,
              eq(taskAssignees.entityId, fixture.taskEntityId),
            ),
          ).toBe(1);
          expect(
            await db.$count(
              entityLinks,
              eq(entityLinks.targetEntityId, fixture.taskEntityId),
            ),
          ).toBe(1);
          expect((await fixture.read()).steps.at(0)?.reviewTaskEntityId).toBe(
            fixture.taskEntityId,
          );
          expect((await fixture.read()).run?.status).toBe("awaiting_review");
          const ordinaryAdd = await Result.gen(() =>
            addAssigneeHandler({
              ...scope,
              body: { taskId: ordinaryId, userId: assigneeId },
            }),
          );
          expect(ordinaryAdd.isOk()).toBe(true);
          const ordinaryLink = await Result.gen(() =>
            createEntityLinkHandler({
              ...scope,
              body: targets({ sourceId: ordinaryId, targetId: otherId }),
            }),
          );
          expect(ordinaryLink.isOk()).toBe(true);
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx.insert(featureEnrolments).values({
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              featureId: "flows",
            });
          });
          await db
            .update(entities)
            .set({ readOnly: false })
            .where(eq(entities.id, fixture.taskEntityId));
          for (const act of actions) {
            // db-await-in-loop: every retained mutation succeeds after the same actor re-grants.
            expect((await act()).isOk()).toBe(true);
          }
          expect(
            await db.$count(
              taskAssignees,
              eq(taskAssignees.entityId, fixture.taskEntityId),
            ),
          ).toBe(1);
          expect(
            await db.$count(entityLinks, eq(entityLinks.id, retainedLinkId)),
          ).toBe(0);
          expect((await fixture.read()).steps.at(0)?.reviewTaskEntityId).toBe(
            fixture.taskEntityId,
          );
        } finally {
          await fixture.cleanup();
          await db.delete(user).where(eq(user.id, assigneeId));
        }
      });
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });
}
