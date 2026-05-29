import { Result } from "better-result";
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
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { authMacro, permissionMacro } from "@/api/lib/auth";

const searchEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: searchBodySchema,
  } satisfies HandlerConfig,
  async function* ({ activeWorkspaceIds, body, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchHandler({
            organizationId: session.activeOrganizationId,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const searchFacetsEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: searchFacetsBodySchema,
  } satisfies HandlerConfig,
  async function* ({ activeWorkspaceIds, body, scopedDb, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchFacetsHandler({
            organizationId: session.activeOrganizationId,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const refineSearchEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: refineSearchBodySchema,
  } satisfies HandlerConfig,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    scopedDb,
    session,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await refineSearchQuery({
            organizationId: session.activeOrganizationId,
            body,
            orgAIConfig,
            promptCachingEnabled,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const summarizeSearchEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: summarizeSearchBodySchema,
  } satisfies HandlerConfig,
  async function* ({
    activeWorkspaceIds,
    body,
    orgAIConfig,
    promptCachingEnabled,
    scopedDb,
    session,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await summarizeSearchResults({
            organizationId: session.activeOrganizationId,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            orgAIConfig,
            promptCachingEnabled,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const searchSummaryChatEndpoint = createSafeRootHandler(
  {
    permissions: { chat: ["create"] },
    body: searchSummaryChatBodySchema,
  } satisfies HandlerConfig,
  async function* ({
    activeWorkspaceIds,
    body,
    safeDb,
    scopedDb,
    session,
    user,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await createSearchSummaryChatThread({
            organizationId: session.activeOrganizationId,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            safeDb,
            scopedDb,
            userId: user.id,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const searchRoute = new Elysia({ prefix: "/search" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", searchEndpoint.handler, {
    body: searchEndpoint.config.body,
    permissions: searchEndpoint.config.permissions,
  })
  .post("/facets", searchFacetsEndpoint.handler, {
    body: searchFacetsEndpoint.config.body,
    permissions: searchFacetsEndpoint.config.permissions,
  })
  .post("/refine", refineSearchEndpoint.handler, {
    body: refineSearchEndpoint.config.body,
    permissions: refineSearchEndpoint.config.permissions,
  })
  .post("/summary", summarizeSearchEndpoint.handler, {
    body: summarizeSearchEndpoint.config.body,
    permissions: summarizeSearchEndpoint.config.permissions,
  })
  .post("/summary/chat", searchSummaryChatEndpoint.handler, {
    body: searchSummaryChatEndpoint.config.body,
    permissions: searchSummaryChatEndpoint.config.permissions,
  });
