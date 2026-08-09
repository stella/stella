import {
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

export const parseWorkspaceRealtimeMessage = (
  data: string,
): WorkspaceRealtimeEvent | null => {
  try {
    return parseWorkspaceRealtimeEvent(JSON.parse(data));
  } catch {
    return null;
  }
};

/**
 * Total query-cache policy for every workspace realtime event kind.
 * A new union member cannot compile until its cache behavior is explicit.
 */
export const getWorkspaceRealtimeQueryKey = (
  event: WorkspaceRealtimeEvent,
): readonly string[] | null => {
  switch (event.type) {
    case REALTIME_EVENT_TYPE.INVALIDATE_QUERY:
      return event.data;
    case REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW:
    case REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE:
      return null;
    default:
      return event satisfies never;
  }
};
