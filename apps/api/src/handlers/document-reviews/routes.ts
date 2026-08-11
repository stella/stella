import Elysia from "elysia";

import compareReferences from "@/api/handlers/document-reviews/compare-references";
import listDocumentReviewSources from "@/api/handlers/document-reviews/list-sources";
import proposeTopics from "@/api/handlers/document-reviews/propose-topics";
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
  });
