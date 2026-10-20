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
  .put(
    "/",
    {
      body: createProperty.config.body,
      permissions: createProperty.config.permissions,
    },
    createProperty.handler,
  )
  .put(
    "/batch",
    {
      body: createPropertiesBatch.config.body,
      permissions: createPropertiesBatch.config.permissions,
    },
    createPropertiesBatch.handler,
  )
  .post(
    "/preview",
    {
      body: previewProperty.config.body,
      permissions: previewProperty.config.permissions,
    },
    previewProperty.handler,
  )
  .post(
    "/suggest-prompt",
    {
      body: suggestPromptProperty.config.body,
      permissions: suggestPromptProperty.config.permissions,
    },
    suggestPromptProperty.handler,
  )
  .get(
    "/",
    {
      permissions: readProperties.config.permissions,
    },
    readProperties.handler,
  )
  .group("/property/:propertyId", (app) =>
    app
      .post(
        "/",
        {
          body: updateProperty.config.body,
          params: updateProperty.config.params,
          permissions: updateProperty.config.permissions,
        },
        updateProperty.handler,
      )
      .delete(
        "/",
        {
          params: deleteProperty.config.params,
          permissions: deleteProperty.config.permissions,
        },
        deleteProperty.handler,
      ),
  );
