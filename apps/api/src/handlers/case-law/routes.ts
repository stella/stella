import generateDecisionAnalysis from "@/api/handlers/case-law/analysis/generate";
import expandCaseLawSearch from "@/api/handlers/case-law/decisions/search-expand";
import refineCaseLawSearch from "@/api/handlers/case-law/decisions/search-refine";
import getCaseLawIngestionStatus from "@/api/handlers/case-law/ingestion/get";
import createMatterLinksBatch from "@/api/handlers/case-law/matter-links/batch/create";
import createMatterLink from "@/api/handlers/case-law/matter-links/create";
import deleteMatterLink from "@/api/handlers/case-law/matter-links/delete";
import listMatterLinks from "@/api/handlers/case-law/matter-links/list";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import { caseLawResearchRoute } from "@/api/handlers/case-law/research/routes";
import { mount, routes } from "@/api/http/route";

const authenticatedCaseLawRoute = routes(
  {
    "/decisions/:decisionId/analysis": { GET: generateDecisionAnalysis },
    "/decisions/search/refine": { POST: refineCaseLawSearch },
    "/decisions/search/expand": { POST: expandCaseLawSearch },
  },
  { prefix: "/case" },
);

/**
 * Workspace-scoped routes: requires workspace access.
 * Links decisions (global) to matters (workspace-scoped).
 */
const caseLawMatterLinksRoute = routes(
  {
    "/": { GET: listMatterLinks, POST: createMatterLink },
    "/batch": { POST: createMatterLinksBatch },
    "/:linkId": { DELETE: deleteMatterLink },
  },
  { prefix: "/case/matter-links/:workspaceId" },
);

/**
 * Admin routes: authenticated. Ingestion observability for operators. The
 * admin/owner gate lives in the handler config (`auditLog: ["read"]`, a
 * permission only owner/admin hold) and is enforced by the safe-handler wrapper,
 * so REST and capability executors share one gate; no route-level hook is needed.
 */
const caseLawAdminRoute = routes(
  {
    "/ingestion/status": { GET: getCaseLawIngestionStatus },
  },
  { prefix: "/case/admin" },
);

export const caseLawRoute = mount([
  publicCaseLawRoute,
  authenticatedCaseLawRoute,
  caseLawResearchRoute,
  caseLawMatterLinksRoute,
  caseLawAdminRoute,
]);
