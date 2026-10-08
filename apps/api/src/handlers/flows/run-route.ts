import Elysia from "elysia";

import cancelFlowRun from "@/api/handlers/flows/runs/cancel";
import getFlowRun from "@/api/handlers/flows/runs/get";
import listFlowRuns from "@/api/handlers/flows/runs/list";
import reviewFlowRun from "@/api/handlers/flows/runs/review";
import startFlowRun from "@/api/handlers/flows/runs/start";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

/** Workspace-scoped flow run lifecycle (start / list / detail / review / cancel). */
export const flowRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/flows/runs",
})
  .use(deploymentFeatureGate(() => isDeploymentFeatureEnabled("FEATURE_FLOWS")))
  .use(featureAccessGate("flows"))
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/", startFlowRun.handler, {
    params: startFlowRun.config.params,
    body: startFlowRun.config.body,
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
    permissions: reviewFlowRun.config.permissions,
  })
  .post("/:runId/cancel", cancelFlowRun.handler, {
    params: cancelFlowRun.config.params,
    permissions: cancelFlowRun.config.permissions,
  });
