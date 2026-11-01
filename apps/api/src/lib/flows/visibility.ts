import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import {
  RESOURCE_DELETION_OWNERSHIP,
  RESOURCE_TYPE,
  type ResourceDeletion,
  resourceRef,
} from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { entityLinks } from "@/api/db/schema";
import {
  auditLogs,
  entities,
  notifications,
  workspaces,
} from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  backgroundFeatureActorExists,
  backgroundFeatureMemberExists,
} from "@/api/lib/feature-access/background";

const classifiedEntityDeletionOwnershipSchema = v.pipe(
  v.picklist(Object.values(RESOURCE_DELETION_OWNERSHIP)),
  v.brand("ClassifiedEntityDeletionOwnership"),
);

type ClassifyEntityResourceDeletionsOptions = {
  workspaceId: SafeId<"workspace">;
  entityIds: readonly SafeId<"entity">[];
};

/** Classify deletions from persisted entity ownership in the deleting transaction. */
export const classifyEntityResourceDeletions = async (
  tx: Pick<Transaction, "select">,
  { workspaceId, entityIds }: ClassifyEntityResourceDeletionsOptions,
) => {
  const flowOwnedEntities =
    entityIds.length === 0
      ? []
      : await tx
          .select({
            entityId: entities.id,
            organizationId: workspaces.organizationId,
          })
          .from(entities)
          .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.featureOwner, "flows"),
              inArray(entities.id, [...entityIds]),
            ),
          )
          .groupBy(entities.id, workspaces.organizationId)
          .limit(entityIds.length);
  const flowOwnedEntityIds = new Set(
    flowOwnedEntities.map(({ entityId }) => entityId),
  );
  const deletions = entityIds.map(
    (id) =>
      ({
        resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id }),
        deletionOwnership: v.parse(
          classifiedEntityDeletionOwnershipSchema,
          flowOwnedEntityIds.has(id)
            ? RESOURCE_DELETION_OWNERSHIP.FLOW_REVIEW_TASK
            : RESOURCE_DELETION_OWNERSHIP.ORDINARY,
        ),
      }) as const satisfies ResourceDeletion,
  );
  return {
    deletions,
    linkedOrganizationId: flowOwnedEntities.at(0)?.organizationId,
  };
};

type FlowFeatureActorVisibilityOptions = {
  organizationId: SQLWrapper | SafeId<"organization">;
  userId: SQLWrapper | string;
  workspaceId: SQLWrapper | string;
};

/** Pure reads evaluate current admission without serializing with grant writes. */
export const flowFeatureActorVisibilitySql = (
  options: FlowFeatureActorVisibilityOptions,
) =>
  isDeploymentFeatureEnabled("FEATURE_FLOWS")
    ? backgroundFeatureActorExists({ ...options, featureId: "flows" })
    : sql`false`;

type ActivityFeatureOwnerVisibilityOptions = {
  featureOwner: SQLWrapper;
  organizationId: SQLWrapper | SafeId<"organization">;
  workspaceId: SQLWrapper | string;
  userId: SQLWrapper | string | null;
};

/** Shared retained activity is visible; feature-owned rows require live admission. */
export const activityFeatureOwnerVisibilitySql = ({
  featureOwner,
  organizationId,
  workspaceId,
  userId,
}: ActivityFeatureOwnerVisibilityOptions) =>
  or(
    eq(featureOwner, "shared"),
    and(
      eq(featureOwner, "flows"),
      userId === null
        ? sql`false`
        : flowFeatureActorVisibilitySql({
            organizationId,
            workspaceId,
            userId,
          }),
    ),
  ) ?? sql`false`;

/** Audit readers hide retained flow activity unless its reader is admitted. */
export const flowAuditVisibilityCondition = ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
}) => {
  const organizationAdmission =
    userId !== null && isDeploymentFeatureEnabled("FEATURE_FLOWS")
      ? backgroundFeatureMemberExists({
          organizationId,
          userId,
          featureId: "flows",
        })
      : sql`false`;
  return (
    or(
      activityFeatureOwnerVisibilitySql({
        featureOwner: auditLogs.featureOwner,
        organizationId,
        workspaceId: auditLogs.workspaceId,
        userId,
      }),
      and(
        eq(auditLogs.featureOwner, "flows"),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.FLOW_DEFINITION),
        isNull(auditLogs.workspaceId),
        organizationAdmission,
      ),
    ) ?? sql`false`
  );
};

type FlowOwnedEntityVisibilitySqlOptions = {
  organizationId: SafeId<"organization">;
  userId: string;
  entityId: SQL;
  workspaceId: SQL;
};

/** Correlated live admission uses the owner persisted by the creating operation. */
export const flowOwnedEntityVisibilitySql = ({
  organizationId,
  userId,
  workspaceId,
  entityId,
}: FlowOwnedEntityVisibilitySqlOptions) => {
  const flowVisibilityEntity = alias(entities, "flow_visibility_entity");
  return sql`EXISTS (
    SELECT 1 FROM ${entities} AS ${flowVisibilityEntity}
    WHERE ${flowVisibilityEntity.workspaceId} = ${workspaceId}
      AND ${flowVisibilityEntity.id} = ${entityId}
      AND (${activityFeatureOwnerVisibilitySql({
        featureOwner: flowVisibilityEntity.featureOwner,
        organizationId,
        workspaceId: flowVisibilityEntity.workspaceId,
        userId,
      })})
  )`;
};

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

/** Hide retained outcomes and mentions of linked review tasks on opt-out. */
export const flowNotificationVisibilityCondition = ({
  organizationId,
  userId,
}: FlowReviewTaskVisibilityOptions) =>
  activityFeatureOwnerVisibilitySql({
    featureOwner: notifications.featureOwner,
    organizationId,
    workspaceId: notifications.workspaceId,
    userId,
  });
