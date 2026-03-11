import Elysia from "elysia";

import {
  createPropertyBodySchema,
  createPropertyHandler,
} from "@/api/handlers/properties/create";
import { deletePropertyHandler } from "@/api/handlers/properties/delete-by-id";
import { readPropertiesHandler } from "@/api/handlers/properties/read";
import {
  updatePropertyBodySchema,
  updatePropertyHandler,
} from "@/api/handlers/properties/update-by-id";
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
  .put(
    "/",
    (ctx) =>
      createPropertyHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { property: ["create"] },
      invalidateQuery: true,
      body: createPropertyBodySchema,
    },
  )
  .get("/", (ctx) =>
    readPropertiesHandler({
      workspaceId: ctx.workspaceId,
      scopedDb: ctx.scopedDb,
    }),
  )
  .group("/property/:propertyId", (app) =>
    app
      .post(
        "/",
        (ctx) =>
          updatePropertyHandler({
            workspaceId: ctx.workspaceId,
            propertyId: ctx.params.propertyId,
            body: ctx.body,
            scopedDb: ctx.scopedDb,
          }),
        {
          permissions: { property: ["update"] },
          invalidateQuery: true,
          body: updatePropertyBodySchema,
        },
      )
      .delete(
        "/",
        (ctx) =>
          deletePropertyHandler({
            workspaceId: ctx.workspaceId,
            propertyId: ctx.params.propertyId,
            scopedDb: ctx.scopedDb,
          }),
        {
          permissions: { property: ["delete"] },
          invalidateQuery: true,
        },
      ),
  );
