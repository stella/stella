import Elysia from "elysia";

import createColumn from "@/api/handlers/lists/columns/create";
import createList from "@/api/handlers/lists/create";
import acceptGenerationCandidate from "@/api/handlers/lists/generation-candidates/acceptance/create";
import submitGenerationCandidates from "@/api/handlers/lists/generation-candidates/create";
import readGenerationCandidates from "@/api/handlers/lists/generation-candidates/list";
import rejectGenerationCandidate from "@/api/handlers/lists/generation-candidates/rejection/create";
import createGeneration from "@/api/handlers/lists/generations/create";
import readGenerations from "@/api/handlers/lists/generations/list";
import readListById from "@/api/handlers/lists/get";
import readItemActivity from "@/api/handlers/lists/items/activity/list";
import createItemComment from "@/api/handlers/lists/items/comments/create";
import readListItems from "@/api/handlers/lists/items/list";
import reviewItem from "@/api/handlers/lists/items/reviews/update";
import createItemSource from "@/api/handlers/lists/items/sources/create";
import readItemSources from "@/api/handlers/lists/items/sources/list";
import updateItem from "@/api/handlers/lists/items/update";
import readLists from "@/api/handlers/lists/list";
import createSection from "@/api/handlers/lists/sections/create";
import updateList from "@/api/handlers/lists/update";
import { createListVerificationRoutes } from "@/api/handlers/lists/verification-routes";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const listsRoute = new Elysia({ prefix: "/lists/:workspaceId" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS"),
    ),
  )
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .use(createListVerificationRoutes())
  .get("/", readLists.handler, {
    permissions: readLists.config.permissions,
    query: readLists.config.query,
  })
  .put("/", createList.handler, {
    body: createList.config.body,
    permissions: createList.config.permissions,
  })
  .patch("/", updateList.handler, {
    body: updateList.config.body,
    permissions: updateList.config.permissions,
  })
  .post("/sections", createSection.handler, {
    body: createSection.config.body,
    permissions: createSection.config.permissions,
  })
  .post("/columns", createColumn.handler, {
    body: createColumn.config.body,
    permissions: createColumn.config.permissions,
  })
  .post("/generations", createGeneration.handler, {
    body: createGeneration.config.body,
    permissions: createGeneration.config.permissions,
  })
  .post("/generation-candidates", submitGenerationCandidates.handler, {
    body: submitGenerationCandidates.config.body,
    permissions: submitGenerationCandidates.config.permissions,
  })
  .post("/generation-candidates/accept", acceptGenerationCandidate.handler, {
    body: acceptGenerationCandidate.config.body,
    permissions: acceptGenerationCandidate.config.permissions,
  })
  .post("/generation-candidates/reject", rejectGenerationCandidate.handler, {
    body: rejectGenerationCandidate.config.body,
    permissions: rejectGenerationCandidate.config.permissions,
  })
  .post("/item-sources", createItemSource.handler, {
    body: createItemSource.config.body,
    permissions: createItemSource.config.permissions,
  })
  .post("/item-comments", createItemComment.handler, {
    body: createItemComment.config.body,
    permissions: createItemComment.config.permissions,
  })
  .post("/item-reviews", reviewItem.handler, {
    body: reviewItem.config.body,
    permissions: reviewItem.config.permissions,
  })
  .patch("/items", updateItem.handler, {
    body: updateItem.config.body,
    permissions: updateItem.config.permissions,
  })
  .get(
    "/:listId/generations/:runId/candidates",
    readGenerationCandidates.handler,
    {
      params: readGenerationCandidates.config.params,
      permissions: readGenerationCandidates.config.permissions,
      query: readGenerationCandidates.config.query,
    },
  )
  .get("/:listId/generations", readGenerations.handler, {
    params: readGenerations.config.params,
    permissions: readGenerations.config.permissions,
    query: readGenerations.config.query,
  })
  .get("/:listId", readListById.handler, {
    params: readListById.config.params,
    permissions: readListById.config.permissions,
  })
  .get("/:listId/items", readListItems.handler, {
    params: readListItems.config.params,
    permissions: readListItems.config.permissions,
    query: readListItems.config.query,
  })
  .get("/:listId/items/:itemEntityId/activity", readItemActivity.handler, {
    params: readItemActivity.config.params,
    permissions: readItemActivity.config.permissions,
    query: readItemActivity.config.query,
  })
  .get("/:listId/items/:itemEntityId/sources", readItemSources.handler, {
    params: readItemSources.config.params,
    permissions: readItemSources.config.permissions,
    query: readItemSources.config.query,
  });
