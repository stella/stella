import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createProperty from "@/api/handlers/properties/create";
import createPropertiesBatch from "@/api/handlers/properties/create-batch";
import deleteProperty from "@/api/handlers/properties/delete";
import readProperties from "@/api/handlers/properties/list";
import previewProperty from "@/api/handlers/properties/preview";
import suggestPromptProperty from "@/api/handlers/properties/suggest-prompt";
import updateProperty from "@/api/handlers/properties/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const propertyRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.PROPERTY,
);

export const propertiesRoute = new Elysia({
  prefix: "/properties/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createProperty.handler, {
    body: createProperty.config.body,
    resourceSetUpdated: propertyRealtimeUpdates,
    permissions: createProperty.config.permissions,
  })
  .put("/batch", createPropertiesBatch.handler, {
    body: createPropertiesBatch.config.body,
    resourceSetUpdated: propertyRealtimeUpdates,
    permissions: createPropertiesBatch.config.permissions,
  })
  .post("/preview", previewProperty.handler, {
    body: previewProperty.config.body,
    permissions: previewProperty.config.permissions,
  })
  .post("/suggest-prompt", suggestPromptProperty.handler, {
    body: suggestPromptProperty.config.body,
    permissions: suggestPromptProperty.config.permissions,
  })
  .get("/", readProperties.handler, {
    permissions: readProperties.config.permissions,
  })
  .group("/property/:propertyId", (app) =>
    app
      .post("/", updateProperty.handler, {
        body: updateProperty.config.body,
        resourceSetUpdated: propertyRealtimeUpdates,
        params: updateProperty.config.params,
        permissions: updateProperty.config.permissions,
      })
      .delete("/", deleteProperty.handler, {
        resourceSetUpdated: propertyRealtimeUpdates,
        params: deleteProperty.config.params,
        permissions: deleteProperty.config.permissions,
      }),
  );
