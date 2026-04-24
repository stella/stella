import Elysia from "elysia";

import { searchBodySchema, searchHandler } from "@/api/handlers/search/search";
import { authMacro } from "@/api/lib/auth";

export const searchRoute = new Elysia({ prefix: "/search" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .post(
    "/",
    async (ctx) =>
      await searchHandler({
        organizationId: ctx.session.activeOrganizationId,
        accessibleWorkspaceIds: ctx.accessibleWorkspaces
          .filter((w) => w.status !== "deleting")
          .map(({ id }) => id),
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    { body: searchBodySchema },
  );
