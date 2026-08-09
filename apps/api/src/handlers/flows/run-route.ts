import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import cancelFlowRun from "@/api/handlers/flows/run-cancel";
import getFlowRun from "@/api/handlers/flows/run-detail";
import listFlowRuns from "@/api/handlers/flows/run-list";
import reviewFlowRun from "@/api/handlers/flows/run-review";
import startFlowRun from "@/api/handlers/flows/run-start";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const flowRunRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.FLOW_RUN,
);

/** Workspace-scoped flow run lifecycle (start / list / detail / review / cancel). */
export const flowRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/flows/runs",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/", startFlowRun.handler, {
    params: startFlowRun.config.params,
    body: startFlowRun.config.body,
    resourceSetUpdated: flowRunRealtimeUpdates,
    permissions: startFlowRun.config.permissions,
  })
  .get("/", listFlowRuns.handler, {
    params: listFlowRuns.config.params,
    query: listFlowRuns.config.query,
    permissions: listFlowRuns.config.permissions,
  })
  .get("/:runId", getFlowRun.handler, {
    params: getFlowRun.config.params,
    permissions: getFlowRun.config.permissions,
  })
  .post("/:runId/review", reviewFlowRun.handler, {
    params: reviewFlowRun.config.params,
    body: reviewFlowRun.config.body,
    resourceSetUpdated: flowRunRealtimeUpdates,
    permissions: reviewFlowRun.config.permissions,
  })
  .post("/:runId/cancel", cancelFlowRun.handler, {
    params: cancelFlowRun.config.params,
    resourceSetUpdated: flowRunRealtimeUpdates,
    permissions: cancelFlowRun.config.permissions,
  });
