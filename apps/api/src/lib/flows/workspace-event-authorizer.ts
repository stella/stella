import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_CHANGE_TYPE,
  RESOURCE_DELETION_OWNERSHIP,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import type { WorkspaceRealtimeEvent } from "@stll/api-contract";

import { entities, flowRuns, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  activityFeatureOwnerVisibilitySql,
  flowFeatureActorVisibilitySql,
} from "@/api/lib/flows/visibility";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const liveEntityTargets = (
  event: WorkspaceRealtimeEvent,
): SafeId<"entity">[] => {
  switch (event.type) {
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
      return event.resource.type === RESOURCE_TYPE.ENTITY
        ? [brandPersistedEntityId(event.resource.id)]
        : [];
    case REALTIME_EVENT_TYPE.RESOURCES_CHANGED:
      return event.changes.flatMap((change) =>
        change.resource.type === RESOURCE_TYPE.ENTITY &&
        change.change === RESOURCE_CHANGE_TYPE.UPDATED
          ? [brandPersistedEntityId(change.resource.id)]
          : [],
      );
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
      return [brandPersistedEntityId(event.data.entityId)];
    case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
    case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      return [];
    default:
      event satisfies never;
      return panic("Workspace event target requires a disposition");
  }
};

const needsFlowAdmission = (event: WorkspaceRealtimeEvent): boolean => {
  switch (event.type) {
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      return true;
    case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
      return (
        event.deletionOwnership === RESOURCE_DELETION_OWNERSHIP.FLOW_REVIEW_TASK
      );
    case REALTIME_EVENT_TYPE.RESOURCES_CHANGED:
      return event.changes.some(
        (change) =>
          change.change === RESOURCE_CHANGE_TYPE.DELETED &&
          change.deletionOwnership ===
            RESOURCE_DELETION_OWNERSHIP.FLOW_REVIEW_TASK,
      );
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
    case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
      return false;
    default:
      event satisfies never;
      return panic("Workspace event admission requires a disposition");
  }
};

type WorkspaceEventProjectionOptions = {
  event: WorkspaceRealtimeEvent;
  organizationId: SQLWrapper;
  workspaceId: SQLWrapper;
  userId: SQLWrapper;
};

/** Project event source and read visibility in the live session audience query. */
export const workspaceEventProjection = ({
  event,
  organizationId,
  workspaceId,
  userId,
}: WorkspaceEventProjectionOptions) => {
  const targets = [...new Set(liveEntityTargets(event))];
  const sourceEntity = alias(entities, "sse_source_entity");
  const sourceWorkspace = alias(workspaces, "sse_source_workspace");
  const sourceRun = alias(flowRuns, "sse_source_run");
  return {
    visibleEntityIds:
      targets.length === 0
        ? sql<string[]>`ARRAY[]::text[]`
        : sql<string[]>`ARRAY(
      SELECT ${sourceEntity.id}::text FROM ${entities} AS ${sourceEntity}
      INNER JOIN ${workspaces} AS ${sourceWorkspace} ON ${sourceWorkspace.id} = ${sourceEntity.workspaceId}
      WHERE ${and(eq(sourceEntity.workspaceId, workspaceId), eq(sourceWorkspace.organizationId, organizationId), inArray(sourceEntity.id, targets), activityFeatureOwnerVisibilitySql({ featureOwner: sourceEntity.featureOwner, organizationId, workspaceId: sourceEntity.workspaceId, userId }))}
      LIMIT ${targets.length}
    )`,
    flowAdmitted: needsFlowAdmission(event)
      ? sql<boolean>`${flowFeatureActorVisibilitySql({ organizationId, workspaceId, userId })}`
      : sql<boolean>`false`,
    sourcePresent:
      event.type === REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE
        ? sql<boolean>`EXISTS(
      SELECT 1 FROM ${flowRuns} AS ${sourceRun}
      INNER JOIN ${workspaces} AS ${sourceWorkspace} ON ${sourceWorkspace.id} = ${sourceRun.workspaceId}
      WHERE ${and(eq(sourceRun.id, toSafeId<"flowRun">(event.data.runId)), eq(sourceRun.workspaceId, workspaceId), eq(sourceWorkspace.organizationId, organizationId))}
    )`
        : sql<boolean>`true`,
  };
};

type WorkspaceEventVisibility = {
  visibleEntityIds: readonly string[];
  flowAdmitted: boolean;
  sourcePresent: boolean;
};

/** Live targets use persisted read policy; deleted targets retain their sealed classification. */
export const workspaceEventDisposition = (
  event: WorkspaceRealtimeEvent,
  visibility: WorkspaceEventVisibility,
) => {
  const hidden = { type: "hidden" } as const;
  const visible = new Set(visibility.visibleEntityIds);
  switch (event.type) {
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      return visibility.sourcePresent && visibility.flowAdmitted
        ? ({ type: "deliver", event } as const)
        : hidden;
    case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
      return event.resource.type !== RESOURCE_TYPE.ENTITY ||
        visible.has(event.resource.id)
        ? ({ type: "deliver", event } as const)
        : hidden;
    case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
      return event.deletionOwnership === RESOURCE_DELETION_OWNERSHIP.ORDINARY ||
        visibility.flowAdmitted
        ? ({ type: "deliver", event } as const)
        : hidden;
    case REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED:
      return { type: "deliver", event } as const;
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
      return visible.has(event.data.entityId)
        ? ({ type: "deliver", event } as const)
        : hidden;
    case REALTIME_EVENT_TYPE.RESOURCES_CHANGED: {
      const changes = event.changes.filter((change) =>
        change.change === RESOURCE_CHANGE_TYPE.DELETED
          ? change.deletionOwnership === RESOURCE_DELETION_OWNERSHIP.ORDINARY ||
            visibility.flowAdmitted
          : change.resource.type !== RESOURCE_TYPE.ENTITY ||
            visible.has(change.resource.id),
      );
      if (changes.length === 0) {
        return hidden;
      }
      return {
        type: "deliver",
        event:
          changes.length === event.changes.length
            ? event
            : { ...event, changes },
      } as const;
    }
    default:
      event satisfies never;
      return panic("Workspace event delivery requires a disposition");
  }
};
