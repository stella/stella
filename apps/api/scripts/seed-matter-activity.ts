/**
 * Seed a compact, realistic Matter Activity timeline for local development.
 *
 * Run after `db:seed-dev`. The deterministic rows are updated in place, so
 * re-running refreshes their relative timestamps without creating duplicates.
 */

import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  auditLogs,
  entities,
  entityVersions,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";

import { DEFAULT_ORG_ID, DEFAULT_USER_ID, seedId } from "./seed-utils";

const MATTER_LABEL = "ws-akvizice-energo";
const WORKSPACE_ID = seedId<"workspace">(MATTER_LABEL);
const DOCUMENT_ID = seedId<"entity">(`${MATTER_LABEL}-doc-1`);
const TASK_ID = seedId<"entity">(`${MATTER_LABEL}-activity-task`);
const TASK_VERSION_ID = seedId<"entityVersion">(
  `${MATTER_LABEL}-activity-task-v1`,
);
const PRIMARY_USER_ID = toSafeId<"user">(DEFAULT_USER_ID);
const COLLEAGUE_USER_ID = toSafeId<"user">("test-user-alice-johnson");

const minutesAgo = (minutes: number, now: Date) =>
  new Date(now.getTime() - minutes * 60_000);

export const seedMatterActivity = async () => {
  if (process.env.NODE_ENV === "production") {
    panic("Refusing to seed Matter Activity in production.");
  }

  const workspace = await rootDb.query.workspaces.findFirst({
    where: {
      id: { eq: WORKSPACE_ID },
      organizationId: { eq: DEFAULT_ORG_ID },
    },
    columns: { id: true },
  });
  if (!workspace) {
    panic("Seed the development dataset before Matter Activity.");
  }

  const now = new Date();
  await rootDb.transaction(async (tx) => {
    await tx
      .insert(entities)
      .values({
        id: TASK_ID,
        workspaceId: WORKSPACE_ID,
        kind: "task",
        name: "Prepare closing checklist",
        displayName: "Prepare closing checklist",
        createdBy: PRIMARY_USER_ID,
        lastEditedBy: PRIMARY_USER_ID,
        status: "in_progress",
        priority: "high",
        dueDate: new Date(now.getTime() + 5 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        agendaKind: "task",
        agendaSource: "manual",
        createdAt: minutesAgo(180, now),
        updatedAt: minutesAgo(21, now),
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          displayName: "Prepare closing checklist",
          name: "Prepare closing checklist",
          status: "in_progress",
          priority: "high",
          updatedAt: minutesAgo(21, now),
        },
      });

    await tx
      .insert(entityVersions)
      .values({
        id: TASK_VERSION_ID,
        workspaceId: WORKSPACE_ID,
        entityId: TASK_ID,
        createdBy: PRIMARY_USER_ID,
        createdAt: minutesAgo(180, now),
      })
      .onConflictDoNothing();
    await tx
      .update(entities)
      .set({ currentVersionId: TASK_VERSION_ID })
      .where(eq(entities.id, TASK_ID));

    const reviewRunId = "dev-contract-review-run";
    const rows = [
      {
        id: seedId<"auditLog">("matter-activity-human-task-create"),
        action: "create",
        activityCategory: "tasks",
        resourceId: TASK_ID,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "user",
        performerId: PRIMARY_USER_ID,
        triggerType: "direct",
        createdAt: minutesAgo(5, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-ai-review-document"),
        action: "review",
        activityCategory: "documents",
        resourceId: DOCUMENT_ID,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "agent",
        performerId: "contract-review-agent",
        performerName: "Contract Review",
        triggerType: "user_dispatch",
        triggerUserId: PRIMARY_USER_ID,
        triggerSource: "chat",
        triggerSourceId: "dev-contract-review-thread",
        runId: reviewRunId,
        groupId: seedId("matter-activity-review-group"),
        createdAt: minutesAgo(20, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-ai-update-task"),
        action: "update",
        activityCategory: "tasks",
        resourceId: TASK_ID,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "agent",
        performerId: "contract-review-agent",
        performerName: "Contract Review",
        triggerType: "user_dispatch",
        triggerUserId: PRIMARY_USER_ID,
        triggerSource: "chat",
        triggerSourceId: "dev-contract-review-thread",
        runId: reviewRunId,
        groupId: seedId("matter-activity-review-group"),
        createdAt: minutesAgo(21, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-scheduled-task"),
        action: "update",
        activityCategory: "tasks",
        resourceId: TASK_ID,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "agent",
        performerId: "deadline-monitor",
        performerName: "Deadline Monitor",
        triggerType: "schedule",
        triggerUserId: PRIMARY_USER_ID,
        triggerSource: "flow",
        triggerSourceId: "closing-deadline-monitor",
        runId: "dev-deadline-monitor-run",
        groupId: seedId("matter-activity-deadline-group"),
        createdAt: minutesAgo(50, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-connected-agent"),
        action: "update",
        activityCategory: "documents",
        resourceId: DOCUMENT_ID,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "agent",
        performerId: "diligence-mcp-agent",
        performerName: "Diligence Agent",
        triggerType: "credential",
        triggerUserId: PRIMARY_USER_ID,
        triggerSource: "mcp",
        triggerSourceId: "dev-mcp-connection",
        runId: "dev-diligence-agent-run",
        groupId: seedId("matter-activity-mcp-group"),
        createdAt: minutesAgo(90, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-colleague-document"),
        action: "update",
        activityCategory: "documents",
        resourceId: DOCUMENT_ID,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "user",
        performerId: COLLEAGUE_USER_ID,
        triggerType: "direct",
        createdAt: minutesAgo(1500, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-matter-update"),
        action: "update",
        activityCategory: "matter",
        resourceId: WORKSPACE_ID,
        resourceType: "workspace",
        performerType: "user",
        performerId: PRIMARY_USER_ID,
        triggerType: "direct",
        createdAt: minutesAgo(1560, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-team-update"),
        action: "update",
        activityCategory: "team",
        resourceId: COLLEAGUE_USER_ID,
        resourceType: "workspace_member",
        performerType: "user",
        performerId: PRIMARY_USER_ID,
        triggerType: "direct",
        createdAt: minutesAgo(3000, now),
      },
      {
        id: seedId<"auditLog">("matter-activity-court-link"),
        action: "create",
        activityCategory: "court",
        resourceId: seedId("matter-activity-court-record"),
        resourceType: "case_law_matter_link",
        performerType: "user",
        performerId: COLLEAGUE_USER_ID,
        triggerType: "direct",
        createdAt: minutesAgo(4500, now),
      },
    ] as const;

    await Promise.all(
      rows.map((row) =>
        tx
          .insert(auditLogs)
          .values({
            organizationId: DEFAULT_ORG_ID,
            workspaceId: WORKSPACE_ID,
            userId: PRIMARY_USER_ID,
            approvalStatus: "not_required",
            ...row,
          })
          .onConflictDoUpdate({
            target: auditLogs.id,
            set: {
              organizationId: DEFAULT_ORG_ID,
              workspaceId: WORKSPACE_ID,
              userId: PRIMARY_USER_ID,
              approvalStatus: "not_required",
              ...row,
            },
          }),
      ),
    );
  });

  await rootDb
    .update(workspaces)
    .set({ lastActivityAt: now })
    .where(eq(workspaces.id, WORKSPACE_ID));

  console.log(
    `Seeded Matter Activity in ${WORKSPACE_ID}: 9 events across 3 days.`,
  );
};

if (import.meta.main) {
  await seedMatterActivity();
}
