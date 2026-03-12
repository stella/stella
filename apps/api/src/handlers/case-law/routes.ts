import Elysia, { t } from "elysia";

import {
  listDecisionsHandler,
  listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/read-by-id";
import {
  searchDecisionsBodySchema,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import {
  createMatterLinkBodySchema,
  createMatterLinkHandler,
} from "@/api/handlers/case-law/matter-links/create";
import { deleteMatterLinkHandler } from "@/api/handlers/case-law/matter-links/delete";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import {
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";

/**
 * Global-read routes: any authenticated user can read.
 * No organizationId filtering; decisions are public records.
 */
const globalCaseLawRoute = new Elysia({
  prefix: "/case-law",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/decisions",
    async (ctx) => await listDecisionsHandler(ctx.query, ctx.scopedDb),
    {
      query: listDecisionsQuerySchema,
    },
  )
  .get(
    "/decisions/:decisionId",
    async (ctx) =>
      await readDecisionHandler(ctx.params.decisionId, ctx.scopedDb),
    { params: t.Object({ decisionId: tNanoid }) },
  )
  .post(
    "/decisions/search",
    async (ctx) => await searchDecisionsHandler(ctx.body, ctx.scopedDb),
    {
      body: searchDecisionsBodySchema,
    },
  );

/**
 * Workspace-scoped routes: requires workspace access.
 * Links decisions (global) to matters (workspace-scoped).
 */
const caseLawMatterLinksRoute = new Elysia({
  prefix: "/case-law/matter-links/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get(
    "/",
    async (ctx) =>
      await listMatterLinksHandler({
        workspaceId: ctx.workspaceId,
        scopedDb: ctx.scopedDb,
      }),
  )
  .post(
    "/",
    async (ctx) =>
      await createMatterLinkHandler({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["create"] },
      body: createMatterLinkBodySchema,
    },
  )
  .delete(
    "/:linkId",
    async (ctx) =>
      await deleteMatterLinkHandler({
        workspaceId: ctx.workspaceId,
        linkId: ctx.params.linkId,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["delete"] },
      params: t.Object({ workspaceId: tNanoid, linkId: tNanoid }),
    },
  );

export const caseLawRoute = new Elysia()
  .use(globalCaseLawRoute)
  .use(caseLawMatterLinksRoute);
