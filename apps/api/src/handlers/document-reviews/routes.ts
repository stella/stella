import Elysia from "elysia";

import createDocumentReviewRun from "@/api/handlers/document-reviews/create-run";
import decideDocumentReviewFinding from "@/api/handlers/document-reviews/decide-finding";
import exportDocumentReviewRun from "@/api/handlers/document-reviews/export-run";
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
  .post("/topics", proposeTopics.handler, {
    body: proposeTopics.config.body,
    permissions: proposeTopics.config.permissions,
  })
  .post("/runs", createDocumentReviewRun.handler, {
    body: createDocumentReviewRun.config.body,
    params: createDocumentReviewRun.config.params,
    permissions: createDocumentReviewRun.config.permissions,
  })
  .get("/runs", listDocumentReviewRuns.handler, {
    params: listDocumentReviewRuns.config.params,
    permissions: listDocumentReviewRuns.config.permissions,
    query: listDocumentReviewRuns.config.query,
  })
  .get("/runs/:runId", readDocumentReviewRun.handler, {
    params: readDocumentReviewRun.config.params,
    permissions: readDocumentReviewRun.config.permissions,
  })
  .get("/runs/:runId/export", exportDocumentReviewRun.handler, {
    params: exportDocumentReviewRun.config.params,
    permissions: exportDocumentReviewRun.config.permissions,
    query: exportDocumentReviewRun.config.query,
  })
  .patch("/findings/:findingId", decideDocumentReviewFinding.handler, {
    body: decideDocumentReviewFinding.config.body,
    params: decideDocumentReviewFinding.config.params,
    permissions: decideDocumentReviewFinding.config.permissions,
  });
