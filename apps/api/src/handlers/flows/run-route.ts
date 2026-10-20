import Elysia from "elysia";

import cancelFlowRun from "@/api/handlers/flows/runs/cancel";
import getFlowRun from "@/api/handlers/flows/runs/get";
import listFlowRuns from "@/api/handlers/flows/runs/list";
import reviewFlowRun from "@/api/handlers/flows/runs/review";
import startFlowRun from "@/api/handlers/flows/runs/start";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

/** Workspace-scoped flow run lifecycle (start / list / detail / review / cancel). */
export const flowRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/flows/runs",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post(
    "/",
    {
      params: startFlowRun.config.params,
      body: startFlowRun.config.body,
      permissions: startFlowRun.config.permissions,
    },
    startFlowRun.handler,
  )
  .get(
    "/",
    {
      params: listFlowRuns.config.params,
      query: listFlowRuns.config.query,
      permissions: listFlowRuns.config.permissions,
    },
    listFlowRuns.handler,
  )
  .get(
    "/:runId",
    {
      params: getFlowRun.config.params,
      permissions: getFlowRun.config.permissions,
    },
    getFlowRun.handler,
  )
  .post(
    "/:runId/review",
    {
      params: reviewFlowRun.config.params,
      body: reviewFlowRun.config.body,
      permissions: reviewFlowRun.config.permissions,
    },
    reviewFlowRun.handler,
  )
  .post(
    "/:runId/cancel",
    {
      params: cancelFlowRun.config.params,
      permissions: cancelFlowRun.config.permissions,
    },
    cancelFlowRun.handler,
  );
