import Elysia from "elysia";

import { searchBodySchema, searchHandler } from "@/api/handlers/search/search";
import { authMacro } from "@/api/lib/auth";

export const searchRoute = new Elysia({ prefix: "/search" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .post(
    "/",
    (ctx) =>
      searchHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    { body: searchBodySchema },
  );
