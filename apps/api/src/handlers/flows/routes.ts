import createFlowDefinition from "@/api/handlers/flows/create";
import deleteFlowDefinition from "@/api/handlers/flows/delete";
import getFlowDefinition from "@/api/handlers/flows/get";
import listFlowDefinitions from "@/api/handlers/flows/list";
import updateFlowDefinition from "@/api/handlers/flows/update";
import { routes } from "@/api/http/route";

/** Org-scoped flow definition CRUD (the "Workflows" recipes). */
export const flowsRoute = routes(
  {
    "/": { GET: listFlowDefinitions, POST: createFlowDefinition },
    "/:flowId": {
      GET: getFlowDefinition,
      PUT: updateFlowDefinition,
      DELETE: deleteFlowDefinition,
    },
  },
  { prefix: "/flows" },
);
