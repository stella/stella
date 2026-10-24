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
    accountAccess: createProperty.config.accountAccess,
  })
  .put("/batch", createPropertiesBatch.handler, {
    body: createPropertiesBatch.config.body,
    permissions: createPropertiesBatch.config.permissions,
    accountAccess: createPropertiesBatch.config.accountAccess,
  })
  .post("/preview", previewProperty.handler, {
    body: previewProperty.config.body,
    permissions: previewProperty.config.permissions,
    accountAccess: previewProperty.config.accountAccess,
  })
  .post("/suggest-prompt", suggestPromptProperty.handler, {
    body: suggestPromptProperty.config.body,
    permissions: suggestPromptProperty.config.permissions,
    accountAccess: suggestPromptProperty.config.accountAccess,
  })
  .get("/", readProperties.handler, {
    permissions: readProperties.config.permissions,
    accountAccess: readProperties.config.accountAccess,
  })
  .group("/property/:propertyId", (app) =>
    app
      .post("/", updateProperty.handler, {
        body: updateProperty.config.body,
        params: updateProperty.config.params,
        permissions: updateProperty.config.permissions,
        accountAccess: updateProperty.config.accountAccess,
      })
      .delete("/", deleteProperty.handler, {
        params: deleteProperty.config.params,
        permissions: deleteProperty.config.permissions,
        accountAccess: deleteProperty.config.accountAccess,
      }),
  );
