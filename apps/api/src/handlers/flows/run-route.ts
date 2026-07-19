import Elysia from "elysia";

import cancelFlowRun from "@/api/handlers/flows/run-cancel";
import getFlowRun from "@/api/handlers/flows/run-detail";
import listFlowRuns from "@/api/handlers/flows/run-list";
import reviewFlowRun from "@/api/handlers/flows/run-review";
import startFlowRun from "@/api/handlers/flows/run-start";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

/** Workspace-scoped flow run lifecycle (start / list / detail / review / cancel). */
export const flowRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/flows/runs",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/", startFlowRun.handler, {
    params: startFlowRun.config.params,
    body: startFlowRun.config.body,
    invalidateQuery: true,
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
    invalidateQuery: true,
    permissions: reviewFlowRun.config.permissions,
  })
  .post("/:runId/cancel", cancelFlowRun.handler, {
    params: cancelFlowRun.config.params,
    invalidateQuery: true,
    permissions: cancelFlowRun.config.permissions,
  });
