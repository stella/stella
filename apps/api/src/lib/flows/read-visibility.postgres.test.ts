import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { entities, featureEnrolments, taskAssignees } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import calendarTasks from "@/api/handlers/tasks/calendar/list";
import readWorkspaces from "@/api/handlers/workspaces/list";
import { toMatterActivityFilters } from "@/api/handlers/workspaces/matter-activity-query";
import { readOverviewActivityActorRows } from "@/api/handlers/workspaces/read-overview-activity-actors.query";
import {
  readOverviewActivityExport,
  readOverviewActivityPage,
} from "@/api/handlers/workspaces/read-overview-activity.query";
import { readSearchPreviewHandler } from "@/api/handlers/workspaces/read-search-preview.query";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { dueAssignedTaskCondition } from "@/api/lib/tasks/assigned";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || !enabled) {
  describe.skip("retained flow work across read surfaces", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("calendar, matter counts, assigned tasks, agenda and activity respect opt-out and regrant", async () => {
    const previousFlag = env.FEATURE_FLOWS;
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
          await db.insert(entities).values({
            id: ordinaryId,
            workspaceId: fixture.workspaceId,
            kind: "task",
            name: "Ordinary task",
            status: "open",
            dueDate: "2099-01-02",
          });
          await db
            .update(entities)
            .set({ dueDate: "2099-01-01" })
            .where(eq(entities.id, fixture.taskEntityId));
          await db.insert(taskAssignees).values(
            [ordinaryId, fixture.taskEntityId].map((entityId) => ({
              id: createSafeId<"taskAssignee">(),
              entityId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
              role: "assignee" as const,
            })),
          );
          await db.transaction(async (tx) => {
            await fixture.recordAuditEvent(tx, {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
              resourceId: fixture.runId,
            });
            await fixture.recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              resourceId: fixture.taskEntityId,
              metadata: { kind: "task" },
            });
            await fixture.recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              resourceId: ordinaryId,
              metadata: { kind: "task" },
            });
          });
          const safeDb = fixture.safeDb(db);
          const scopedDb = createScopedDb(
            markRlsDatabase(db),
            [fixture.workspaceId],
            fixture.organizationId,
            fixture.userId,
          );
          const principal = {
            organizationId: fixture.organizationId,
            userId: fixture.userId,
          };
          const activityOptions = {
            ...principal,
            workspaceId: fixture.workspaceId,
            safeDb,
            filters: toMatterActivityFilters({}),
          };
          const context = {
            safeDb,
            scopedDb,
            workspaceId: fixture.workspaceId,
            memberRole: sessionMemberRole("owner"),
            session: { activeOrganizationId: fixture.organizationId },
            user: { id: fixture.userId },
          };
          const readSurfaces = async () => {
            const calendar = await calendarTasks.handler(
              asTestRaw<Parameters<typeof calendarTasks.handler>[0]>({
                ...context,
                body: {
                  dateFrom: "2099-01-01T00:00:00Z",
                  dateTo: "2099-01-03T00:00:00Z",
                  datePropertyIds: ["_due-date"],
                },
              }),
            );
            const matters = await readWorkspaces.handler(
              asTestRaw<Parameters<typeof readWorkspaces.handler>[0]>(context),
            );
            const preview = await readSearchPreviewHandler({
              ...principal,
              scopedDb,
              workspaceId: fixture.workspaceId,
            });
            const assigned = await scopedDb((tx) =>
              tx
                .select({ id: entities.id })
                .from(entities)
                .where(
                  dueAssignedTaskCondition({
                    ...principal,
                    asOf: "2099-01-02",
                  }),
                ),
            );
            const activity = (
              await readOverviewActivityPage({
                ...activityOptions,
                cursor: null,
                limit: 20,
              })
            ).unwrap();
            const exported = (
              await readOverviewActivityExport({ ...activityOptions, cap: 20 })
            ).unwrap();
            const actors = (
              await readOverviewActivityActorRows({
                ...principal,
                workspaceId: fixture.workspaceId,
                safeDb,
                afterActorId: null,
                limit: 20,
                search: "",
              })
            ).unwrap();
            return {
              calendarIds: asTestRaw<{ tasks: { taskId: string }[] }>(calendar)
                .tasks.map(({ taskId }) => taskId)
                .toSorted(),
              matter: asTestRaw<{
                workspaces: {
                  entityCount: number;
                  openTaskCount: number;
                  nextDeadline: string | null;
                }[];
              }>(matters).workspaces.at(0),
              agendaIds: preview.upcomingAgenda.map(({ id }) => id).toSorted(),
              assignedIds: assigned.map(({ id }) => id).toSorted(),
              activityCount: activity.items.length,
              exportedCount: exported.length,
              actorCount: actors.length,
            };
          };
          const bothIds = [ordinaryId, fixture.taskEntityId].toSorted();
          const visible = await readSurfaces();
          expect(visible).toMatchObject({
            calendarIds: bothIds,
            agendaIds: bothIds,
            assignedIds: bothIds,
            matter: {
              entityCount: 2,
              openTaskCount: 2,
              nextDeadline: "2099-01-01",
            },
            activityCount: 3,
            exportedCount: 3,
            actorCount: 1,
          });
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
          expect(await readSurfaces()).toMatchObject({
            calendarIds: [ordinaryId],
            agendaIds: [ordinaryId],
            assignedIds: [ordinaryId],
            matter: {
              entityCount: 1,
              openTaskCount: 1,
              nextDeadline: "2099-01-02",
            },
            activityCount: 1,
            exportedCount: 1,
            actorCount: 1,
          });
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx
              .insert(featureEnrolments)
              .values({ ...principal, featureId: "flows" });
          });
          expect(await readSurfaces()).toEqual(visible);
          testState.setConfig("FEATURE_FLOWS", false);
          expect(await readSurfaces()).toMatchObject({
            calendarIds: [ordinaryId],
            agendaIds: [ordinaryId],
            assignedIds: [ordinaryId],
            activityCount: 1,
            exportedCount: 1,
            actorCount: 1,
          });
        } finally {
          await fixture.cleanup();
        }
      });
    } finally {
      testState.setConfig("FEATURE_FLOWS", previousFlag);
      restore();
    }
  });
}
