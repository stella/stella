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
  .get(
    "/",
    {
      permissions: listFlowDefinitions.config.permissions,
      query: listFlowDefinitions.config.query,
    },
    listFlowDefinitions.handler,
  )
  .post(
    "/",
    {
      body: createFlowDefinition.config.body,
      permissions: createFlowDefinition.config.permissions,
    },
    createFlowDefinition.handler,
  )
  .get(
    "/:flowId",
    {
      params: getFlowDefinition.config.params,
      permissions: getFlowDefinition.config.permissions,
    },
    getFlowDefinition.handler,
  )
  .put(
    "/:flowId",
    {
      body: updateFlowDefinition.config.body,
      params: updateFlowDefinition.config.params,
      permissions: updateFlowDefinition.config.permissions,
    },
    updateFlowDefinition.handler,
  )
  .delete(
    "/:flowId",
    {
      params: deleteFlowDefinition.config.params,
      permissions: deleteFlowDefinition.config.permissions,
    },
    deleteFlowDefinition.handler,
  );
