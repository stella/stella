import Elysia from "elysia";

import generateDecisionAnalysis from "@/api/handlers/case-law/analysis/generate";
import getCaseLawIngestionStatus from "@/api/handlers/case-law/ingestion/status";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import deleteMatterLink from "@/api/handlers/case-law/matter-links/delete";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import {
  authMacro,
  permissionMacro,
  workspaceAccessMacro,
} from "@/api/lib/auth";

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
  .use(caseLawMatterLinksRoute)
  .use(caseLawAdminRoute);
