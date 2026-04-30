import Elysia from "elysia";

import {
  refineSearchBodySchema,
  refineSearchQuery,
  searchSummaryChatBodySchema,
  createSearchSummaryChatThread,
  summarizeSearchBodySchema,
  summarizeSearchResults,
} from "@/api/handlers/search/ai";
import {
  searchFacetsBodySchema,
  searchFacetsHandler,
} from "@/api/handlers/search/facets";
import { searchBodySchema, searchHandler } from "@/api/handlers/search/search";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const searchRoute = new Elysia({ prefix: "/search" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post(
    "/",
    async (ctx) =>
      await searchHandler({
        organizationId: ctx.session.activeOrganizationId,
        accessibleWorkspaceIds: ctx.activeWorkspaceIds,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    { body: searchBodySchema },
  )
  .post(
    "/facets",
    async (ctx) =>
      await searchFacetsHandler({
        organizationId: ctx.session.activeOrganizationId,
        accessibleWorkspaceIds: ctx.activeWorkspaceIds,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    { body: searchFacetsBodySchema },
  )
  .post(
    "/refine",
    async (ctx) =>
      await refineSearchQuery({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
        orgAIConfig: ctx.orgAIConfig,
        scopedDb: ctx.scopedDb,
      }),
    { body: refineSearchBodySchema },
  )
  .post(
    "/summary",
    async (ctx) =>
      await summarizeSearchResults({
        organizationId: ctx.session.activeOrganizationId,
        accessibleWorkspaceIds: ctx.activeWorkspaceIds,
        body: ctx.body,
        orgAIConfig: ctx.orgAIConfig,
        scopedDb: ctx.scopedDb,
      }),
    { body: summarizeSearchBodySchema },
  )
  .post(
    "/summary/chat",
    async (ctx) =>
      await createSearchSummaryChatThread({
        organizationId: ctx.session.activeOrganizationId,
        accessibleWorkspaceIds: ctx.activeWorkspaceIds,
        body: ctx.body,
        safeDb: ctx.safeDb,
        scopedDb: ctx.scopedDb,
        userId: ctx.user.id,
      }),
    {
      body: searchSummaryChatBodySchema,
      permissions: { chat: ["create"] },
    },
  );
