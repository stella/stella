import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { generateAnalysis } from "@/api/handlers/case-law/analysis/generate";
import {
  listDecisionsHandler,
  listDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/list";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/read-by-id";
import {
  searchDecisionsBodySchema,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import { getIngestionStatus } from "@/api/handlers/case-law/ingestion/status";
import {
  createMatterLinkBodySchema,
  createMatterLinkHandler,
} from "@/api/handlers/case-law/matter-links/create";
import { deleteMatterLinkHandler } from "@/api/handlers/case-law/matter-links/delete";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import {
  createSafeHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  ADMIN_BYPASS_ROLES,
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";
import { tSafeId } from "@/api/lib/custom-schema";

const listDecisions = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: listDecisionsQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await listDecisionsHandler(query, scopedDb),
      ),
    );

    return Result.ok(response);
  },
);

const readDecision = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  } satisfies HandlerConfig,
  async function* ({ params: { decisionId }, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readDecisionHandler(decisionId, scopedDb),
      ),
    );

    return Result.ok(response);
  },
);

const searchDecisions = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    body: searchDecisionsBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await searchDecisionsHandler(body, scopedDb),
      ),
    );

    return Result.ok(response);
  },
);

const generateDecisionAnalysis = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
  } satisfies HandlerConfig,
  async function* ({ params: { decisionId }, scopedDb, orgAIConfig }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await generateAnalysis(decisionId, scopedDb, orgAIConfig),
      ),
    );

    return Result.ok(response);
  },
);

const listMatterLinks = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listMatterLinksHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const createMatterLink = createSafeHandler(
  {
    permissions: { entity: ["create"] },
    body: createMatterLinkBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, scopedDb, user, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await createMatterLinkHandler({
            workspaceId,
            userId: user.id,
            body,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const deleteMatterLink = createSafeHandler(
  {
    permissions: { entity: ["delete"] },
    params: t.Object({
      workspaceId: tSafeId("workspace"),
      linkId: tSafeId("caseLawMatterLink"),
    }),
  } satisfies HandlerConfig,
  async function* ({ params: { linkId }, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await deleteMatterLinkHandler({
            workspaceId,
            linkId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const getCaseLawIngestionStatus = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await getIngestionStatus(scopedDb)),
    );

    return Result.ok(response);
  },
);

/**
 * Global-read routes: any authenticated user can read.
 * No organizationId filtering; decisions are public records.
 */
const globalCaseLawRoute = new Elysia({
  prefix: "/case",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get("/decisions", listDecisions.handler, {
    query: listDecisions.config.query,
  })
  .get("/decisions/:decisionId", readDecision.handler, {
    params: readDecision.config.params,
  })
  .post("/decisions/search", searchDecisions.handler, {
    body: searchDecisions.config.body,
  })
  .get("/decisions/:decisionId/analysis", generateDecisionAnalysis.handler, {
    params: generateDecisionAnalysis.config.params,
  });

/**
 * Workspace-scoped routes: requires workspace access.
 * Links decisions (global) to matters (workspace-scoped).
 */
const caseLawMatterLinksRoute = new Elysia({
  prefix: "/case/matter-links/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get("/", listMatterLinks.handler)
  .post("/", createMatterLink.handler, {
    body: createMatterLink.config.body,
  })
  .delete("/:linkId", deleteMatterLink.handler, {
    params: deleteMatterLink.config.params,
  });

/**
 * Admin routes: authenticated + admin/owner role.
 * Ingestion observability for operators.
 */
const caseLawAdminRoute = new Elysia({
  prefix: "/case/admin",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .onBeforeHandle(({ memberRole, set }) => {
    if (!ADMIN_BYPASS_ROLES.includes(memberRole.role)) {
      set.status = 403;
      return { error: "Forbidden" } as const;
    }
    return undefined;
  })
  .get("/ingestion/status", getCaseLawIngestionStatus.handler);

export const caseLawRoute = new Elysia()
  .use(globalCaseLawRoute)
  .use(caseLawMatterLinksRoute)
  .use(caseLawAdminRoute);
