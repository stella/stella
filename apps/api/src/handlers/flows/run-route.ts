import cancelFlowRun from "@/api/handlers/flows/runs/cancel";
import getFlowRun from "@/api/handlers/flows/runs/get";
import listFlowRuns from "@/api/handlers/flows/runs/list";
import reviewFlowRun from "@/api/handlers/flows/runs/review";
import startFlowRun from "@/api/handlers/flows/runs/start";
import { routes } from "@/api/http/route";

/** Workspace-scoped flow run lifecycle (start / list / detail / review / cancel). */
export const flowRunsRoute = routes(
  {
    "/": { POST: startFlowRun, GET: listFlowRuns },
    "/:runId": { GET: getFlowRun },
    "/:runId/review": { POST: reviewFlowRun },
    "/:runId/cancel": { POST: cancelFlowRun },
  },
  { prefix: "/workspaces/:workspaceId/flows/runs" },
);
