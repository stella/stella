import Elysia from "elysia";

import createProperty from "@/api/handlers/properties/create";
import deleteProperty from "@/api/handlers/properties/delete-by-id";
import readProperties from "@/api/handlers/properties/read";
import updateProperty from "@/api/handlers/properties/update-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const propertiesRoute = new Elysia({
  prefix: "/properties/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createProperty.handler, {
    body: createProperty.config.body,
    invalidateQuery: true,
  })
  .get("/", readProperties.handler)
  .group("/property/:propertyId", (app) =>
    app
      .post("/", updateProperty.handler, {
        body: updateProperty.config.body,
        invalidateQuery: true,
      })
      .delete("/", deleteProperty.handler, {
        invalidateQuery: true,
      }),
  );
