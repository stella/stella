import Elysia from "elysia";

import createPropertiesBatch from "@/api/handlers/properties/batch/create";
import createProperty from "@/api/handlers/properties/create";
import deleteProperty from "@/api/handlers/properties/delete";
import readProperties from "@/api/handlers/properties/list";
import previewProperty from "@/api/handlers/properties/preview";
import suggestPromptProperty from "@/api/handlers/properties/prompt/suggest";
import updateProperty from "@/api/handlers/properties/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const propertiesRoute = new Elysia({
  prefix: "/properties/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createProperty.handler, {
    body: createProperty.config.body,
    permissions: createProperty.config.permissions,
  })
  .put("/batch", createPropertiesBatch.handler, {
    body: createPropertiesBatch.config.body,
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
        params: updateProperty.config.params,
        permissions: updateProperty.config.permissions,
      })
      .delete("/", deleteProperty.handler, {
        params: deleteProperty.config.params,
        permissions: deleteProperty.config.permissions,
      }),
  );
