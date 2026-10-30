import createClauseCategory from "@/api/handlers/clauses/categories/create";
import deleteClauseCategory from "@/api/handlers/clauses/categories/delete";
import listClauseCategories from "@/api/handlers/clauses/categories/list";
import updateClauseCategory from "@/api/handlers/clauses/categories/update";
import createClause from "@/api/handlers/clauses/create";
import deleteClause from "@/api/handlers/clauses/delete";
import exportClauses from "@/api/handlers/clauses/export";
import getClause from "@/api/handlers/clauses/get";
import importClauses from "@/api/handlers/clauses/import";
import listClauses from "@/api/handlers/clauses/list";
import rewriteClause from "@/api/handlers/clauses/rewrite";
import getTemplateClausePreview from "@/api/handlers/clauses/template-slots/preview";
import updateClause from "@/api/handlers/clauses/update";
import createVariant from "@/api/handlers/clauses/variants/create";
import deleteVariant from "@/api/handlers/clauses/variants/delete";
import listVariants from "@/api/handlers/clauses/variants/list";
import updateVariant from "@/api/handlers/clauses/variants/update";
import clauseVersionDiff from "@/api/handlers/clauses/versions/diff";
import getClauseVersion from "@/api/handlers/clauses/versions/get";
import restoreClauseVersion from "@/api/handlers/clauses/versions/restore";
import clauseVersionSummarize from "@/api/handlers/clauses/versions/summarize";
import { routes } from "@/api/http/route";

// ── Categories ──────────────────────────────────────

export const clauseCategoriesRoute = routes(
  {
    "/": { GET: listClauseCategories, PUT: createClauseCategory },
    "/:categoryId": {
      POST: updateClauseCategory,
      DELETE: deleteClauseCategory,
    },
  },
  { prefix: "/clause-categories" },
);

// ── Clauses ─────────────────────────────────────────

export const clausesRoute = routes(
  {
    "/": { GET: listClauses, PUT: createClause },
    "/export": { GET: exportClauses },
    "/import": { PUT: importClauses, POST: importClauses },
    "/ai-rewrite": { POST: rewriteClause },
    "/template-slot-preview/:templateId": { GET: getTemplateClausePreview },
    "/:clauseId": { GET: getClause, POST: updateClause, DELETE: deleteClause },
    "/:clauseId/versions/:versionId": { GET: getClauseVersion },
    "/:clauseId/versions/:versionId/diff": { GET: clauseVersionDiff },
    "/:clauseId/versions/:versionId/summarize": {
      POST: clauseVersionSummarize,
    },
    "/:clauseId/versions/:versionId/restore": { POST: restoreClauseVersion },
    "/:clauseId/variants": { GET: listVariants, PUT: createVariant },
    "/:clauseId/variants/:variantId": {
      POST: updateVariant,
      DELETE: deleteVariant,
    },
  },
  { prefix: "/clauses" },
);
