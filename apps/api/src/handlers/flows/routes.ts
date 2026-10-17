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
    accountAccess: listFlowDefinitions.config.accountAccess,
    query: listFlowDefinitions.config.query,
  })
  .post("/", createFlowDefinition.handler, {
    body: createFlowDefinition.config.body,
    permissions: createFlowDefinition.config.permissions,
    accountAccess: createFlowDefinition.config.accountAccess,
  })
  .get("/:flowId", getFlowDefinition.handler, {
    params: getFlowDefinition.config.params,
    permissions: getFlowDefinition.config.permissions,
    accountAccess: getFlowDefinition.config.accountAccess,
  })
  .put("/:flowId", updateFlowDefinition.handler, {
    body: updateFlowDefinition.config.body,
    params: updateFlowDefinition.config.params,
    permissions: updateFlowDefinition.config.permissions,
    accountAccess: updateFlowDefinition.config.accountAccess,
  })
  .delete("/:flowId", deleteFlowDefinition.handler, {
    params: deleteFlowDefinition.config.params,
    permissions: deleteFlowDefinition.config.permissions,
    accountAccess: deleteFlowDefinition.config.accountAccess,
  });
