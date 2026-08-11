import Elysia from "elysia";

import compareReferences from "@/api/handlers/document-reviews/compare-references";
import createDocumentReviewRun from "@/api/handlers/document-reviews/create-run";
import listDocumentReviewRuns from "@/api/handlers/document-reviews/list-runs";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import proposeTopics from "@/api/handlers/document-reviews/propose-topics";
import readDocumentReviewRun from "@/api/handlers/document-reviews/read-run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const documentReviewsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/document-reviews",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get("/sources", listDocumentReviewSources.handler, {
    query: listDocumentReviewSources.config.query,
    permissions: listDocumentReviewSources.config.permissions,
  })
  .post("/references", compareReferences.handler, {
    body: compareReferences.config.body,
    permissions: compareReferences.config.permissions,
  })
  .post("/topics", proposeTopics.handler, {
    body: proposeTopics.config.body,
    permissions: proposeTopics.config.permissions,
  })
  .post("/runs", createDocumentReviewRun.handler, {
    body: createDocumentReviewRun.config.body,
    permissions: createDocumentReviewRun.config.permissions,
  })
  .get("/runs", listDocumentReviewRuns.handler, {
    query: listDocumentReviewRuns.config.query,
    permissions: listDocumentReviewRuns.config.permissions,
  })
  .get("/runs/:runId", readDocumentReviewRun.handler, {
    params: readDocumentReviewRun.config.params,
    permissions: readDocumentReviewRun.config.permissions,
  });
