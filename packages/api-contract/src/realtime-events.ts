import * as v from "valibot";

import { FLOW_RUN_STATUSES, FLOW_RUN_STEP_STATUSES } from "./flow-status";
import {
  isResourceRef,
  isResourceType,
  type RESOURCE_TYPE,
  type ResourceRef,
  type ResourceType,
} from "./resource-ref";

export const REALTIME_EVENT_TYPE = {
  DESKTOP_EDIT_SESSION_CLOSED: "__desktop_edit_session_closed__",
  FLOW_RUN_UPDATE: "flow-run-update",
  NEW_NOTIFICATION: "new-notification",
  RESOURCE_DELETED: "resource.deleted",
  RESOURCE_SET_UPDATED: "resource-set.updated",
  RESOURCE_UPDATED: "resource.updated",
  RESOURCES_CHANGED: "resources.changed",
  SESSION_CLOSED: "session-closed",
  SESSION_TAKEN_OVER: "session-taken-over",
  TAKEOVER_REQUESTED: "takeover-requested",
  WORKFLOW_EXTRACTION_PREVIEW: "workflow-extraction-preview",
} as const;

export const RESOURCE_CHANGE_TYPE = {
  DELETED: "deleted",
  UPDATED: "updated",
} as const;

export const RESOURCE_DELETION_OWNERSHIP = {
  ORDINARY: "ordinary",
  FLOW_REVIEW_TASK: "flow-review-task",
} as const;

const resourceDeletionOwnershipSchema = v.picklist(
  Object.values(RESOURCE_DELETION_OWNERSHIP),
);

/** Entity ownership is produced by the transactional classifier, never a caller label. */
type ClassifiedEntityDeletionOwnership = v.InferOutput<
  typeof resourceDeletionOwnershipSchema
> &
  v.Brand<"ClassifiedEntityDeletionOwnership">;

export type ResourceDeletion =
  | {
      resource: Extract<ResourceRef, { type: typeof RESOURCE_TYPE.ENTITY }>;
      deletionOwnership: ClassifiedEntityDeletionOwnership;
    }
  | {
      resource: Exclude<ResourceRef, { type: typeof RESOURCE_TYPE.ENTITY }>;
      deletionOwnership: v.InferOutput<typeof resourceDeletionOwnershipSchema>;
    };

export const MAX_RESOURCE_CHANGES_PER_EVENT = 100;

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const resourceRefSchema = v.custom<ResourceRef>(isResourceRef);

const resourceUpdatedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.RESOURCE_UPDATED),
  resource: resourceRefSchema,
});

const resourceDeletedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.RESOURCE_DELETED),
  resource: resourceRefSchema,
  deletionOwnership: resourceDeletionOwnershipSchema,
});

const resourceChangeSchema = v.variant("change", [
  v.object({
    change: v.literal(RESOURCE_CHANGE_TYPE.UPDATED),
    resource: resourceRefSchema,
  }),
  v.object({
    change: v.literal(RESOURCE_CHANGE_TYPE.DELETED),
    resource: resourceRefSchema,
    deletionOwnership: resourceDeletionOwnershipSchema,
  }),
]);

const resourcesChangedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.RESOURCES_CHANGED),
  changes: v.pipe(
    v.array(resourceChangeSchema),
    v.minLength(1),
    v.maxLength(MAX_RESOURCE_CHANGES_PER_EVENT),
  ),
});

const resourceSetUpdatedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED),
  resourceType: v.custom<ResourceType>(isResourceType),
});

const resourceRealtimeEventSchema = v.variant("type", [
  resourceUpdatedEventSchema,
  resourceDeletedEventSchema,
  resourcesChangedEventSchema,
  resourceSetUpdatedEventSchema,
]);

const workflowExtractionPreviewEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW),
  data: v.object({
    entityId: nonEmptyStringSchema,
    entityVersionId: nonEmptyStringSchema,
    propertyId: nonEmptyStringSchema,
    answer: v.nullable(v.string()),
    status: v.picklist(["streaming", "clear"]),
  }),
});

const flowRunUpdateEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE),
  data: v.object({
    runId: nonEmptyStringSchema,
    status: v.picklist(FLOW_RUN_STATUSES),
    currentStepIndex: v.number(),
    steps: v.array(
      v.object({
        index: v.number(),
        status: v.picklist(FLOW_RUN_STEP_STATUSES),
      }),
    ),
  }),
});

const workspaceRealtimeEventSchema = v.variant("type", [
  resourceUpdatedEventSchema,
  resourceDeletedEventSchema,
  resourcesChangedEventSchema,
  resourceSetUpdatedEventSchema,
  workflowExtractionPreviewEventSchema,
  flowRunUpdateEventSchema,
]);

const organizationRealtimeEventSchema = resourceSetUpdatedEventSchema;

/**
 * User-channel event announcing that the recipient's notification list
 * changed. Deliberately content-free: the stream fans out to every tab a user
 * has open, including tabs on other organizations, so it carries no row id, no
 * kind and no metadata. The client re-reads the first page and the unread
 * count through the ordinary authorized endpoint.
 */
const newNotificationEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.NEW_NOTIFICATION),
  data: v.null(),
});

const userRealtimeEventSchema = v.variant("type", [newNotificationEventSchema]);

export type ResourceChange = v.InferOutput<typeof resourceChangeSchema>;

export type ResourceRealtimeEvent = v.InferOutput<
  typeof resourceRealtimeEventSchema
>;

export type WorkspaceRealtimeEvent = v.InferOutput<
  typeof workspaceRealtimeEventSchema
>;
/** A producer capability; copies and wire parsing cannot reconstruct its private field. */
class BuiltRealtimeEvent<
  TEvent extends WorkspaceRealtimeEvent = WorkspaceRealtimeEvent,
> {
  readonly #event: TEvent;

  constructor(event: TEvent) {
    this.#event = structuredClone(event);
    Object.freeze(this);
  }

  /** Project a detached wire payload so receivers cannot mutate the producer capability. */
  readonly toJSON = () => structuredClone(this.#event);
}

export type { BuiltRealtimeEvent };

export type OrganizationRealtimeEvent = v.InferOutput<
  typeof organizationRealtimeEventSchema
>;
export type UserRealtimeEvent = v.InferOutput<typeof userRealtimeEventSchema>;

export const newNotificationRealtimeEvent = () =>
  ({
    type: REALTIME_EVENT_TYPE.NEW_NOTIFICATION,
    data: null,
  }) as const satisfies UserRealtimeEvent;

export const resourceUpdatedRealtimeEvent = (resource: ResourceRef) =>
  new BuiltRealtimeEvent(
    v.parse(resourceUpdatedEventSchema, {
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource,
    }),
  );

export const resourceDeletedRealtimeEvent = ({
  resource,
  deletionOwnership,
}: ResourceDeletion) =>
  new BuiltRealtimeEvent(
    v.parse(resourceDeletedEventSchema, {
      type: REALTIME_EVENT_TYPE.RESOURCE_DELETED,
      resource,
      deletionOwnership,
    }),
  );

export const resourceUpdatedChange = (resource: ResourceRef) =>
  ({
    change: RESOURCE_CHANGE_TYPE.UPDATED,
    resource,
  }) as const satisfies ResourceChange;

export type ResourceChangeInput =
  | Extract<ResourceChange, { change: typeof RESOURCE_CHANGE_TYPE.UPDATED }>
  | (ResourceDeletion & { change: typeof RESOURCE_CHANGE_TYPE.DELETED });

export const resourceDeletedChange = (deletion: ResourceDeletion) =>
  ({
    change: RESOURCE_CHANGE_TYPE.DELETED,
    ...deletion,
  }) as const satisfies ResourceChangeInput;

export const resourcesChangedRealtimeEvent = (
  changes: readonly ResourceChangeInput[],
) =>
  new BuiltRealtimeEvent(
    v.parse(resourcesChangedEventSchema, {
      type: REALTIME_EVENT_TYPE.RESOURCES_CHANGED,
      changes: [...changes],
    }),
  );

export const resourceSetUpdatedRealtimeEvent = (resourceType: ResourceType) =>
  new BuiltRealtimeEvent(
    v.parse(resourceSetUpdatedEventSchema, {
      type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
      resourceType,
    }),
  );

export const flowRunUpdateRealtimeEvent = (
  data: v.InferInput<typeof flowRunUpdateEventSchema>["data"],
) =>
  new BuiltRealtimeEvent(
    v.parse(flowRunUpdateEventSchema, {
      type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
      data,
    }),
  );

export const workflowExtractionPreviewRealtimeEvent = (
  data: v.InferInput<typeof workflowExtractionPreviewEventSchema>["data"],
) =>
  new BuiltRealtimeEvent(
    v.parse(workflowExtractionPreviewEventSchema, {
      type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
      data,
    }),
  );

const takeoverRequestedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.TAKEOVER_REQUESTED),
  data: v.object({
    requestedBy: nonEmptyStringSchema,
    requestedAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
});

const sessionTakenOverEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.SESSION_TAKEN_OVER),
  data: v.object({ message: nonEmptyStringSchema }),
});

const sessionClosedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.SESSION_CLOSED),
  data: v.object({ reason: nonEmptyStringSchema }),
});

const desktopEditSessionClosedEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.DESKTOP_EDIT_SESSION_CLOSED),
  data: v.null(),
});

const desktopEditSessionRealtimeEventSchema = v.variant("type", [
  takeoverRequestedEventSchema,
  sessionTakenOverEventSchema,
  sessionClosedEventSchema,
  desktopEditSessionClosedEventSchema,
]);

export type DesktopEditSessionRealtimeEvent = v.InferOutput<
  typeof desktopEditSessionRealtimeEventSchema
>;
export type DesktopEditSessionClientEvent = Exclude<
  DesktopEditSessionRealtimeEvent,
  { type: typeof REALTIME_EVENT_TYPE.DESKTOP_EDIT_SESSION_CLOSED }
>;

export const parseWorkspaceRealtimeEvent = (
  input: unknown,
): WorkspaceRealtimeEvent | null => {
  const result = v.safeParse(workspaceRealtimeEventSchema, input);
  return result.success ? result.output : null;
};

export const parseOrganizationRealtimeEvent = (
  input: unknown,
): OrganizationRealtimeEvent | null => {
  const result = v.safeParse(organizationRealtimeEventSchema, input);
  return result.success ? result.output : null;
};

export const parseUserRealtimeEvent = (
  input: unknown,
): UserRealtimeEvent | null => {
  const result = v.safeParse(userRealtimeEventSchema, input);
  return result.success ? result.output : null;
};

export const parseDesktopEditSessionRealtimeEvent = (
  input: unknown,
): DesktopEditSessionRealtimeEvent | null => {
  const result = v.safeParse(desktopEditSessionRealtimeEventSchema, input);
  return result.success ? result.output : null;
};
