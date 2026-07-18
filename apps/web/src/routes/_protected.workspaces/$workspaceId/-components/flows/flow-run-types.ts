import type { api } from "@/lib/api";

// Workflow-run (internal: "flow run") shapes inferred from the Eden surface so
// the UI stays in lockstep with the workspace-scoped run handlers under
// `/workspaces/:workspaceId/flows/runs`. Never hand-redefine these.

type WorkspaceClient = ReturnType<typeof api.workspaces>;
type FlowRunsClient = WorkspaceClient["flows"]["runs"];

type FlowRunsListResponse = Awaited<ReturnType<FlowRunsClient["get"]>>;
type FlowRunsListData = Exclude<
  NonNullable<Extract<FlowRunsListResponse, { data: unknown }>["data"]>,
  Response
>;
export type FlowRunListItem = FlowRunsListData["items"][number];

type FlowRunByIdClient = ReturnType<FlowRunsClient>;
type FlowRunDetailResponse = Awaited<ReturnType<FlowRunByIdClient["get"]>>;
export type FlowRunDetail = Exclude<
  NonNullable<Extract<FlowRunDetailResponse, { data: unknown }>["data"]>,
  Response
>;
export type FlowRunStepRun = FlowRunDetail["stepRuns"][number];
