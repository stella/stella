import { and, notInArray, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_KIND,
  NOTIFICATION_KINDS,
} from "@stll/api-contract/notifications";
import type { NotificationKind } from "@stll/api-contract/notifications";

import type { entityLinks } from "@/api/db/schema";
import { entities, flowRunSteps, notifications } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";

type FlowFeatureActorVisibilityOptions = {
  organizationId: SafeId<"organization">;
  userId: string;
  workspaceId: SQLWrapper | string;
};

/** Pure reads evaluate current admission without serializing with grant writes. */
export const flowFeatureActorVisibilitySql = (
  options: FlowFeatureActorVisibilityOptions,
) =>
  isDeploymentFeatureEnabled("FEATURE_FLOWS")
    ? backgroundFeatureActorExists({ ...options, featureId: "flows" })
    : sql`false`;

type FlowOwnedEntityVisibilitySqlOptions = {
  organizationId: SafeId<"organization">;
  userId: string;
  entityId: SQL;
  workspaceId: SQL;
};

type FlowOwnedEntityVisibilityOptions = FlowOwnedEntityVisibilitySqlOptions & {
  entityMatch: SQL;
};

const flowOwnedEntityVisibilityCondition = ({
  organizationId,
  userId,
  workspaceId,
  entityMatch,
}: FlowOwnedEntityVisibilityOptions) => sql`NOT EXISTS (
  SELECT 1 FROM ${flowRunSteps}
  WHERE ${flowRunSteps.workspaceId} = ${workspaceId}
    AND ${entityMatch}
    AND NOT (${flowFeatureActorVisibilitySql({ organizationId, workspaceId, userId })})
)`;

/** Correlated live admission keeps hidden review tasks out of reads and facets. */
export const flowOwnedEntityVisibilitySql = (
  options: FlowOwnedEntityVisibilitySqlOptions,
) =>
  flowOwnedEntityVisibilityCondition({
    ...options,
    entityMatch: sql`${flowRunSteps.reviewTaskEntityId} = ${options.entityId}`,
  });

/** Audit targets are text and may be legacy identifiers; never cast them to UUID. */
export const flowOwnedEntityTextVisibilitySql = (
  options: FlowOwnedEntityVisibilitySqlOptions,
) =>
  flowOwnedEntityVisibilityCondition({
    ...options,
    entityMatch: sql`${flowRunSteps.reviewTaskEntityId}::text = ${options.entityId}`,
  });

type FlowReviewTaskVisibilityOptions = {
  organizationId: SafeId<"organization">;
  userId: string;
};

/** Apply live admission before pagination, including when initially granted. */
export const flowReviewTaskVisibilityCondition = (
  options: FlowReviewTaskVisibilityOptions,
) =>
  flowOwnedEntityVisibilitySql({
    ...options,
    entityId: sql`${entities.id}`,
    workspaceId: sql`${entities.workspaceId}`,
  });

/** Relational callbacks retain live admission for child and both link endpoints. */
export const flowRelatedTaskVisibilityConditions = (
  options: FlowReviewTaskVisibilityOptions,
) => ({
  entity: ({ workspaceId, id }: Pick<typeof entities, "workspaceId" | "id">) =>
    flowOwnedEntityVisibilitySql({
      ...options,
      entityId: sql`${id}`,
      workspaceId: sql`${workspaceId}`,
    }),
  link: ({
    workspaceId,
    sourceEntityId,
    targetEntityId,
  }: Pick<
    typeof entityLinks,
    "workspaceId" | "sourceEntityId" | "targetEntityId"
  >) =>
    sql`${flowOwnedEntityVisibilitySql({ ...options, entityId: sql`${sourceEntityId}`, workspaceId: sql`${workspaceId}` })} AND ${flowOwnedEntityVisibilitySql({ ...options, entityId: sql`${targetEntityId}`, workspaceId: sql`${workspaceId}` })}`,
});

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
export const flowNotificationVisibilityCondition = ({
  organizationId,
  userId,
}: FlowReviewTaskVisibilityOptions) => {
  const admission = flowFeatureActorVisibilitySql({
    organizationId,
    workspaceId: notifications.workspaceId,
    userId,
  });
  return sql`${or(
    admission,
    and(
      notInArray(notifications.kind, FLOW_NOTIFICATION_KINDS),
      sql`${notifications.entityType} IS DISTINCT FROM ${NOTIFICATION_ENTITY_TYPE.FLOW_RUN}`,
    ),
  )} AND NOT EXISTS (
    SELECT 1 FROM ${flowRunSteps}
    WHERE ${notifications.entityType} = ${NOTIFICATION_ENTITY_TYPE.ENTITY}
      AND ${flowRunSteps.workspaceId} = ${notifications.workspaceId}
      AND ${flowRunSteps.reviewTaskEntityId}::text = ${notifications.entityId}
      AND NOT (${admission})
  )`;
};
