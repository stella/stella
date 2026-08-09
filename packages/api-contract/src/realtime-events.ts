import * as v from "valibot";

import { FLOW_RUN_STATUSES, FLOW_RUN_STEP_STATUSES } from "./flow-status";

export const REALTIME_EVENT_TYPE = {
  DESKTOP_EDIT_SESSION_CLOSED: "__desktop_edit_session_closed__",
  FLOW_RUN_UPDATE: "flow-run-update",
  INVALIDATE_QUERY: "invalidate-query",
  SESSION_CLOSED: "session-closed",
  SESSION_TAKEN_OVER: "session-taken-over",
  TAKEOVER_REQUESTED: "takeover-requested",
  WORKFLOW_EXTRACTION_PREVIEW: "workflow-extraction-preview",
} as const;

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const invalidateQueryEventSchema = v.object({
  type: v.literal(REALTIME_EVENT_TYPE.INVALIDATE_QUERY),
  data: v.pipe(v.array(nonEmptyStringSchema), v.minLength(1)),
});

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
  invalidateQueryEventSchema,
  workflowExtractionPreviewEventSchema,
  flowRunUpdateEventSchema,
]);

const organizationRealtimeEventSchema = invalidateQueryEventSchema;

export type WorkspaceRealtimeEvent = v.InferOutput<
  typeof workspaceRealtimeEventSchema
>;
export type OrganizationRealtimeEvent = v.InferOutput<
  typeof organizationRealtimeEventSchema
>;

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

export const parseDesktopEditSessionRealtimeEvent = (
  input: unknown,
): DesktopEditSessionRealtimeEvent | null => {
  const result = v.safeParse(desktopEditSessionRealtimeEventSchema, input);
  return result.success ? result.output : null;
};
