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
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const propertiesRoute = new Elysia({
  prefix: "/properties/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/",
    (ctx) =>
      createPropertyHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createPropertyBodySchema,
    },
  )
  .get("/", async (ctx) =>
    readPropertiesHandler({
      workspaceId: ctx.workspaceId,
    }),
  )
  .group("/property/:propertyId", (app) =>
    app
      .post(
        "/",
        async (ctx) =>
          updatePropertyHandler({
            workspaceId: ctx.workspaceId,
            propertyId: ctx.params.propertyId,
            body: ctx.body,
          }),
        {
          invalidateQuery: true,
          body: updatePropertyBodySchema,
        },
      )
      .delete(
        "/",
        async (ctx) =>
          deletePropertyHandler({
            propertyId: ctx.params.propertyId,
          }),
        {
          invalidateQuery: true,
        },
      ),
  );
