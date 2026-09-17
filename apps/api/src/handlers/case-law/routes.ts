import Elysia from "elysia";

import generateDecisionAnalysis from "@/api/handlers/case-law/analysis/generate";
import checkCitation from "@/api/handlers/case-law/citations/check";
import getCaseLawIngestionStatus from "@/api/handlers/case-law/ingestion/status";
import createMatterLinksBatch from "@/api/handlers/case-law/matter-links/batch/create";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import deleteMatterLink from "@/api/handlers/case-law/matter-links/delete";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import { caseLawResearchRoute } from "@/api/handlers/case-law/research/routes";
import {
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const authenticatedCaseLawRoute = new Elysia({
  prefix: "/case",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/decisions/:decisionId/analysis", generateDecisionAnalysis.handler, {
    params: generateDecisionAnalysis.config.params,
    permissions: generateDecisionAnalysis.config.permissions,
  });

/**
 * A citation check resolves a reference against the corpus and sends one
 * decision's passages to the typed judgment model, so it carries a budget of
 * its own rather than drawing on the general API one. The limiter is scoped
 * to this plugin, which is why it needs no path predicate.
 */
const caseLawCitationRoute = new Elysia({ prefix: "/case/citations" })
  .use(
    rateLimit({
      duration: API_RATE_LIMITS.caseLawCitationCheck.duration,
      max: API_RATE_LIMITS.caseLawCitationCheck.max,
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "case-law-citation-check",
      }),
    }),
  )
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/check", checkCitation.handler, {
    body: checkCitation.config.body,
    permissions: checkCitation.config.permissions,
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
  .get("/", listMatterLinks.handler, {
    permissions: listMatterLinks.config.permissions,
  })
  .post("/", createMatterLink.handler, {
    body: createMatterLink.config.body,
    permissions: createMatterLink.config.permissions,
  })
  .post("/batch", createMatterLinksBatch.handler, {
    body: createMatterLinksBatch.config.body,
    permissions: createMatterLinksBatch.config.permissions,
  })
  .delete("/:linkId", deleteMatterLink.handler, {
    params: deleteMatterLink.config.params,
    permissions: deleteMatterLink.config.permissions,
  });

/**
 * Admin routes: authenticated. Ingestion observability for operators. The
 * admin/owner gate lives in the handler config (`auditLog: ["read"]`, a
 * permission only owner/admin hold) and is enforced by the safe-handler wrapper,
 * so REST and `invoke_capability` share one gate; no route-level hook is needed.
 */
const caseLawAdminRoute = new Elysia({
  prefix: "/case/admin",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/ingestion/status", getCaseLawIngestionStatus.handler, {
    permissions: getCaseLawIngestionStatus.config.permissions,
  });

export const caseLawRoute = new Elysia()
  .use(publicCaseLawRoute)
  .use(authenticatedCaseLawRoute)
  .use(caseLawCitationRoute)
  .use(caseLawResearchRoute)
  .use(caseLawMatterLinksRoute)
  .use(caseLawAdminRoute);
