/**
 * Seed a compact, realistic Matter Activity timeline for local development.
 *
 * Run after `db:seed-dev`. The deterministic rows are updated in place, so
 * re-running refreshes their relative timestamps without creating duplicates.
 * Set MATTER_ACTIVITY_WORKSPACE_ID and MATTER_ACTIVITY_USER_ID to seed a
 * specific accessible matter instead of the default development matter.
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

import { DEFAULT_USER_ID, seedId } from "./seed-utils";

const MATTER_LABEL = "ws-akvizice-energo";
const DEFAULT_WORKSPACE_ID = seedId<"workspace">(MATTER_LABEL);

const minutesAgo = (minutes: number, now: Date) =>
  new Date(now.getTime() - minutes * 60_000);

export const seedMatterActivity = async () => {
  if (process.env.NODE_ENV === "production") {
    panic("Refusing to seed Matter Activity in production.");
  }

  const configuredWorkspaceId = process.env["MATTER_ACTIVITY_WORKSPACE_ID"];
  const workspaceId = configuredWorkspaceId
    ? toSafeId<"workspace">(configuredWorkspaceId)
    : DEFAULT_WORKSPACE_ID;
  const workspace = await rootDb.query.workspaces.findFirst({
    where: {
      id: { eq: workspaceId },
    },
    columns: { id: true, organizationId: true },
  });
  if (!workspace) {
    panic(`Matter Activity target workspace not found: ${workspaceId}`);
  }

  const members = await rootDb.query.workspaceMembers.findMany({
    where: { workspaceId: { eq: workspaceId } },
    columns: { userId: true },
    limit: 2,
  });
  const configuredUserIdValue = process.env["MATTER_ACTIVITY_USER_ID"];
  const configuredUserId = configuredUserIdValue
    ? toSafeId<"user">(configuredUserIdValue)
    : undefined;
  const defaultUserId =
    workspaceId === DEFAULT_WORKSPACE_ID
      ? toSafeId<"user">(DEFAULT_USER_ID)
      : undefined;
  const requestedUserId = configuredUserId ?? defaultUserId;
  const requestedMembership = requestedUserId
    ? await rootDb.query.workspaceMembers.findFirst({
        where: {
          workspaceId: { eq: workspaceId },
          userId: { eq: requestedUserId },
        },
        columns: { userId: true },
      })
    : undefined;
  const primaryUserId = requestedMembership?.userId ?? members.at(0)?.userId;
  if (!primaryUserId || (requestedUserId && !requestedMembership)) {
    panic("Matter Activity user must be a member of the target workspace.");
  }
  const colleagueUserId =
    members.find(({ userId }) => userId !== primaryUserId)?.userId ??
    primaryUserId;

  const document = await rootDb.query.entities.findFirst({
    where: { workspaceId: { eq: workspaceId }, kind: { eq: "document" } },
    columns: { id: true },
  });
  if (!document) {
    panic("Matter Activity target workspace must contain a document.");
  }

  const taskId = seedId<"entity">(`${workspaceId}-activity-task`);
  const taskVersionId = seedId<"entityVersion">(
    `${workspaceId}-activity-task-v1`,
  );
  const activityId = (label: string) =>
    seedId<"auditLog">(`${workspaceId}-${label}`);
  const groupId = (label: string) => seedId(`${workspaceId}-${label}`);

  const now = new Date();
  await rootDb.transaction(async (tx) => {
    await tx
      .insert(entities)
      .values({
        id: taskId,
        workspaceId,
        kind: "task",
        name: "Prepare closing checklist",
        displayName: "Prepare closing checklist",
        createdBy: primaryUserId,
        lastEditedBy: primaryUserId,
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
        id: taskVersionId,
        workspaceId,
        entityId: taskId,
        createdBy: primaryUserId,
        createdAt: minutesAgo(180, now),
      })
      .onConflictDoNothing();
    await tx
      .update(entities)
      .set({ currentVersionId: taskVersionId })
      .where(eq(entities.id, taskId));

    const reviewRunId = `${workspaceId}-contract-review-run`;
    const rows = [
      {
        id: activityId("matter-activity-human-task-create"),
        action: "create",
        activityCategory: "tasks",
        resourceId: taskId,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "user",
        performerId: primaryUserId,
        triggerType: "direct",
        createdAt: minutesAgo(5, now),
      },
      {
        id: activityId("matter-activity-ai-review-document"),
        action: "review",
        activityCategory: "documents",
        resourceId: document.id,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "agent",
        performerId: "contract-review-agent",
        performerName: "Contract Review",
        triggerType: "user_dispatch",
        triggerUserId: primaryUserId,
        triggerSource: "chat",
        triggerSourceId: "dev-contract-review-thread",
        runId: reviewRunId,
        groupId: groupId("matter-activity-review-group"),
        createdAt: minutesAgo(20, now),
      },
      {
        id: activityId("matter-activity-ai-update-task"),
        action: "update",
        activityCategory: "tasks",
        resourceId: taskId,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "agent",
        performerId: "contract-review-agent",
        performerName: "Contract Review",
        triggerType: "user_dispatch",
        triggerUserId: primaryUserId,
        triggerSource: "chat",
        triggerSourceId: "dev-contract-review-thread",
        runId: reviewRunId,
        groupId: groupId("matter-activity-review-group"),
        createdAt: minutesAgo(21, now),
      },
      {
        id: activityId("matter-activity-scheduled-task"),
        action: "update",
        activityCategory: "tasks",
        resourceId: taskId,
        resourceType: "entity",
        metadata: { kind: "task" },
        performerType: "agent",
        performerId: "deadline-monitor",
        performerName: "Deadline Monitor",
        triggerType: "schedule",
        triggerUserId: primaryUserId,
        triggerSource: "flow",
        triggerSourceId: "closing-deadline-monitor",
        runId: `${workspaceId}-deadline-monitor-run`,
        groupId: groupId("matter-activity-deadline-group"),
        createdAt: minutesAgo(50, now),
      },
      {
        id: activityId("matter-activity-connected-agent"),
        action: "update",
        activityCategory: "documents",
        resourceId: document.id,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "agent",
        performerId: "diligence-mcp-agent",
        performerName: "Diligence Agent",
        triggerType: "credential",
        triggerUserId: primaryUserId,
        triggerSource: "mcp",
        triggerSourceId: "dev-mcp-connection",
        runId: `${workspaceId}-diligence-agent-run`,
        groupId: groupId("matter-activity-mcp-group"),
        createdAt: minutesAgo(90, now),
      },
      {
        id: activityId("matter-activity-colleague-document"),
        action: "update",
        activityCategory: "documents",
        resourceId: document.id,
        resourceType: "entity",
        metadata: { kind: "document" },
        performerType: "user",
        performerId: colleagueUserId,
        triggerType: "direct",
        createdAt: minutesAgo(1500, now),
      },
      {
        id: activityId("matter-activity-matter-update"),
        action: "update",
        activityCategory: "matter",
        resourceId: workspaceId,
        resourceType: "workspace",
        performerType: "user",
        performerId: primaryUserId,
        triggerType: "direct",
        createdAt: minutesAgo(1560, now),
      },
      {
        id: activityId("matter-activity-team-update"),
        action: "update",
        activityCategory: "team",
        resourceId: colleagueUserId,
        resourceType: "workspace_member",
        performerType: "user",
        performerId: primaryUserId,
        triggerType: "direct",
        createdAt: minutesAgo(3000, now),
      },
      {
        id: activityId("matter-activity-court-link"),
        action: "create",
        activityCategory: "court",
        resourceId: groupId("matter-activity-court-record"),
        resourceType: "case_law_matter_link",
        performerType: "user",
        performerId: colleagueUserId,
        triggerType: "direct",
        createdAt: minutesAgo(4500, now),
      },
    ] as const;

    await Promise.all(
      rows.map((row) =>
        tx
          .insert(auditLogs)
          .values({
            organizationId: workspace.organizationId,
            workspaceId,
            userId: primaryUserId,
            approvalStatus: "not_required",
            ...row,
          })
          .onConflictDoUpdate({
            target: auditLogs.id,
            set: {
              organizationId: workspace.organizationId,
              workspaceId,
              userId: primaryUserId,
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
    .where(eq(workspaces.id, workspaceId));

  console.log(
    `Seeded Matter Activity in ${workspaceId}: 9 events across 3 days.`,
  );
};

if (import.meta.main) {
  await seedMatterActivity();
}
