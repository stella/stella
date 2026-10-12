import Elysia from "elysia";

import createDocumentReviewRun from "@/api/handlers/document-reviews/create-run";
import decideDocumentReviewFinding from "@/api/handlers/document-reviews/decide-finding";
import exportDocumentReviewRun from "@/api/handlers/document-reviews/export-run";
import listDocumentReviewRuns from "@/api/handlers/document-reviews/list-runs";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import reviewParties from "@/api/handlers/document-reviews/parties";
import proposePositions from "@/api/handlers/document-reviews/propose-positions";
import proposePositionsStream from "@/api/handlers/document-reviews/propose-positions-stream";
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
    accountAccess: listDocumentReviewSources.config.accountAccess,
  })
  .post("/positions", proposePositions.handler, {
    body: proposePositions.config.body,
    permissions: proposePositions.config.permissions,
    accountAccess: proposePositions.config.accountAccess,
  })
  .post("/positions/stream", proposePositionsStream.handler, {
    body: proposePositionsStream.config.body,
    permissions: proposePositionsStream.config.permissions,
    accountAccess: proposePositionsStream.config.accountAccess,
  })
  .post("/parties", reviewParties.handler, {
    body: reviewParties.config.body,
    permissions: reviewParties.config.permissions,
    accountAccess: reviewParties.config.accountAccess,
  })
  .post("/runs", createDocumentReviewRun.handler, {
    body: createDocumentReviewRun.config.body,
    params: createDocumentReviewRun.config.params,
    permissions: createDocumentReviewRun.config.permissions,
    accountAccess: createDocumentReviewRun.config.accountAccess,
  })
  .get("/runs", listDocumentReviewRuns.handler, {
    params: listDocumentReviewRuns.config.params,
    permissions: listDocumentReviewRuns.config.permissions,
    accountAccess: listDocumentReviewRuns.config.accountAccess,
    query: listDocumentReviewRuns.config.query,
  })
  .get("/runs/:runId", readDocumentReviewRun.handler, {
    params: readDocumentReviewRun.config.params,
    permissions: readDocumentReviewRun.config.permissions,
    accountAccess: readDocumentReviewRun.config.accountAccess,
  })
  .get("/runs/:runId/export", exportDocumentReviewRun.handler, {
    params: exportDocumentReviewRun.config.params,
    permissions: exportDocumentReviewRun.config.permissions,
    accountAccess: exportDocumentReviewRun.config.accountAccess,
    query: exportDocumentReviewRun.config.query,
  })
  .patch("/findings/:findingId", decideDocumentReviewFinding.handler, {
    body: decideDocumentReviewFinding.config.body,
    params: decideDocumentReviewFinding.config.params,
    permissions: decideDocumentReviewFinding.config.permissions,
    accountAccess: decideDocumentReviewFinding.config.accountAccess,
  });
