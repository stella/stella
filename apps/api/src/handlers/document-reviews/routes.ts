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
  .get(
    "/sources",
    {
      query: listDocumentReviewSources.config.query,
      permissions: listDocumentReviewSources.config.permissions,
    },
    listDocumentReviewSources.handler,
  )
  .post(
    "/positions",
    {
      body: proposePositions.config.body,
      permissions: proposePositions.config.permissions,
    },
    proposePositions.handler,
  )
  .post(
    "/positions/stream",
    {
      body: proposePositionsStream.config.body,
      permissions: proposePositionsStream.config.permissions,
    },
    proposePositionsStream.handler,
  )
  .post(
    "/parties",
    {
      body: reviewParties.config.body,
      permissions: reviewParties.config.permissions,
    },
    reviewParties.handler,
  )
  .post(
    "/runs",
    {
      body: createDocumentReviewRun.config.body,
      params: createDocumentReviewRun.config.params,
      permissions: createDocumentReviewRun.config.permissions,
    },
    createDocumentReviewRun.handler,
  )
  .get(
    "/runs",
    {
      params: listDocumentReviewRuns.config.params,
      permissions: listDocumentReviewRuns.config.permissions,
      query: listDocumentReviewRuns.config.query,
    },
    listDocumentReviewRuns.handler,
  )
  .get(
    "/runs/:runId",
    {
      params: readDocumentReviewRun.config.params,
      permissions: readDocumentReviewRun.config.permissions,
    },
    readDocumentReviewRun.handler,
  )
  .get(
    "/runs/:runId/export",
    {
      params: exportDocumentReviewRun.config.params,
      permissions: exportDocumentReviewRun.config.permissions,
      query: exportDocumentReviewRun.config.query,
    },
    exportDocumentReviewRun.handler,
  )
  .patch(
    "/findings/:findingId",
    {
      body: decideDocumentReviewFinding.config.body,
      params: decideDocumentReviewFinding.config.params,
      permissions: decideDocumentReviewFinding.config.permissions,
    },
    decideDocumentReviewFinding.handler,
  );
