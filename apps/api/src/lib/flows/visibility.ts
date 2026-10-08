import { Result } from "better-result";
import { and, notInArray, sql } from "drizzle-orm";

import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_KIND,
  NOTIFICATION_KINDS,
} from "@stll/api-contract/notifications";
import type { NotificationKind } from "@stll/api-contract/notifications";

import type { SafeDb } from "@/api/db/safe-db";
import type { entityLinks } from "@/api/db/schema";
import { entities, flowRunSteps, notifications } from "@/api/db/schema";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

type FlowReviewTaskVisibilityOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: string;
};

/** A retained flow pointer has the same admission as its owning flow. */
export const canViewFlowData = async ({
  safeDb,
  organizationId,
  userId,
}: FlowReviewTaskVisibilityOptions) => {
  if (isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    const snapshot = await loadFeatureAccessSnapshot({
      safeDb,
      organizationId,
      userId,
    });
    if (snapshot.isErr()) {
      return Result.err(snapshot.error);
    }
    if (isFeatureEnabled(snapshot.value, "flows", { organizationId, userId })) {
      return Result.ok(true);
    }
  }
  return Result.ok(false);
};

/** Apply before pagination so hidden reviews consume neither rows nor cursors. */
export const flowReviewTaskVisibilityCondition = async (
  options: FlowReviewTaskVisibilityOptions,
) => {
  const access = await canViewFlowData(options);
  if (access.isErr()) {
    return Result.err(access.error);
  }
  if (access.value) {
    return Result.ok(undefined);
  }
  return Result.ok(sql`NOT EXISTS (
    SELECT 1 FROM ${flowRunSteps}
    WHERE ${flowRunSteps.workspaceId} = ${entities.workspaceId}
      AND ${flowRunSteps.reviewTaskEntityId} = ${entities.id}
  )`);
};

/** Relational RAW callbacks bind child/link aliases before applying limits. */
export const flowRelatedTaskVisibilityConditions = async (
  options: FlowReviewTaskVisibilityOptions,
) => {
  const access = await canViewFlowData(options);
  if (access.isErr()) {
    return Result.err(access.error);
  }
  if (access.value) {
    return Result.ok(undefined);
  }
  return Result.ok({
    entity: ({
      workspaceId,
      id,
    }: Pick<typeof entities, "workspaceId" | "id">) => sql`NOT EXISTS (
      SELECT 1 FROM ${flowRunSteps}
      WHERE ${flowRunSteps.workspaceId} = ${workspaceId}
        AND ${flowRunSteps.reviewTaskEntityId} = ${id}
    )`,
    link: ({
      workspaceId,
      sourceEntityId,
      targetEntityId,
    }: Pick<
      typeof entityLinks,
      "workspaceId" | "sourceEntityId" | "targetEntityId"
    >) => sql`NOT EXISTS (
    SELECT 1 FROM ${flowRunSteps}
    WHERE ${flowRunSteps.workspaceId} = ${workspaceId}
      AND (${flowRunSteps.reviewTaskEntityId} = ${sourceEntityId}
        OR ${flowRunSteps.reviewTaskEntityId} = ${targetEntityId})
  )`,
  });
};

const NOTIFICATION_FEATURE_OWNER = {
  [NOTIFICATION_KIND.MENTION]: "shared",
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]: "shared",
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]: "shared",
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: "flows",
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: "flows",
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]: "flows",
  [NOTIFICATION_KIND.ANNOUNCEMENT]: "shared",
} as const satisfies Record<NotificationKind, "flows" | "shared">;

const FLOW_NOTIFICATION_KINDS = NOTIFICATION_KINDS.filter(
  (kind) => NOTIFICATION_FEATURE_OWNER[kind] === "flows",
);

/** Hide retained outcomes and mentions of linked review tasks on opt-out. */
export const flowNotificationVisibilityCondition = async (
  options: FlowReviewTaskVisibilityOptions,
) => {
  const access = await canViewFlowData(options);
  if (access.isErr()) {
    return Result.err(access.error);
  }
  if (access.value) {
    return Result.ok(undefined);
  }
  return Result.ok(
    and(
      notInArray(notifications.kind, FLOW_NOTIFICATION_KINDS),
      sql`${notifications.entityType} IS DISTINCT FROM ${NOTIFICATION_ENTITY_TYPE.FLOW_RUN}`,
      sql`NOT EXISTS (
      SELECT 1 FROM ${flowRunSteps}
      WHERE ${notifications.entityType} = ${NOTIFICATION_ENTITY_TYPE.ENTITY}
        AND ${flowRunSteps.workspaceId} = ${notifications.workspaceId}
        AND ${flowRunSteps.reviewTaskEntityId}::text = ${notifications.entityId}
    )`,
    ),
  );
};
