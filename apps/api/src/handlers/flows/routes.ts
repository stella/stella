import Elysia from "elysia";

import createFlowDefinition from "@/api/handlers/flows/create";
import deleteFlowDefinition from "@/api/handlers/flows/delete";
import getFlowDefinition from "@/api/handlers/flows/get";
import listFlowDefinitions from "@/api/handlers/flows/list";
import updateFlowDefinition from "@/api/handlers/flows/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/** Org-scoped flow definition CRUD (the "Workflows" recipes). */
export const flowsRoute = new Elysia({ prefix: "/flows" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listFlowDefinitions.handler, {
    permissions: listFlowDefinitions.config.permissions,
    query: listFlowDefinitions.config.query,
  })
  .post("/", createFlowDefinition.handler, {
    body: createFlowDefinition.config.body,
    permissions: createFlowDefinition.config.permissions,
  })
  .get("/:flowId", getFlowDefinition.handler, {
    params: getFlowDefinition.config.params,
    permissions: getFlowDefinition.config.permissions,
  })
  .put("/:flowId", updateFlowDefinition.handler, {
    body: updateFlowDefinition.config.body,
    params: updateFlowDefinition.config.params,
    permissions: updateFlowDefinition.config.permissions,
  })
  .delete("/:flowId", deleteFlowDefinition.handler, {
    params: deleteFlowDefinition.config.params,
    permissions: deleteFlowDefinition.config.permissions,
  });
