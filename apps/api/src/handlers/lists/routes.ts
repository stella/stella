import Elysia from "elysia";

import { env } from "@/api/env";
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
import verifyItemSource from "@/api/handlers/lists/items/sources/verification/update";
import updateItem from "@/api/handlers/lists/items/update";
import readLists from "@/api/handlers/lists/list";
import createSection from "@/api/handlers/lists/sections/create";
import updateList from "@/api/handlers/lists/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const listsRoute = new Elysia({ prefix: "/lists/:workspaceId" })
  .use(deploymentFeatureGate(env.FEATURE_LEGAL_LISTS))
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .get("/", readLists.handler, {
    permissions: readLists.config.permissions,
    query: readLists.config.query,
  })
  .put("/", createList.handler, {
    body: createList.config.body,
    invalidateQuery: true,
    permissions: createList.config.permissions,
  })
  .patch("/", updateList.handler, {
    body: updateList.config.body,
    invalidateQuery: true,
    permissions: updateList.config.permissions,
  })
  .post("/sections", createSection.handler, {
    body: createSection.config.body,
    invalidateQuery: true,
    permissions: createSection.config.permissions,
  })
  .post("/columns", createColumn.handler, {
    body: createColumn.config.body,
    invalidateQuery: true,
    permissions: createColumn.config.permissions,
  })
  .post("/generations", createGeneration.handler, {
    body: createGeneration.config.body,
    invalidateQuery: true,
    permissions: createGeneration.config.permissions,
  })
  .post("/generation-candidates", submitGenerationCandidates.handler, {
    body: submitGenerationCandidates.config.body,
    invalidateQuery: true,
    permissions: submitGenerationCandidates.config.permissions,
  })
  .post("/generation-candidates/accept", acceptGenerationCandidate.handler, {
    body: acceptGenerationCandidate.config.body,
    invalidateQuery: true,
    permissions: acceptGenerationCandidate.config.permissions,
  })
  .post("/generation-candidates/reject", rejectGenerationCandidate.handler, {
    body: rejectGenerationCandidate.config.body,
    invalidateQuery: true,
    permissions: rejectGenerationCandidate.config.permissions,
  })
  .post("/item-sources", createItemSource.handler, {
    body: createItemSource.config.body,
    invalidateQuery: true,
    permissions: createItemSource.config.permissions,
  })
  .post("/item-comments", createItemComment.handler, {
    body: createItemComment.config.body,
    invalidateQuery: true,
    permissions: createItemComment.config.permissions,
  })
  .post("/item-reviews", reviewItem.handler, {
    body: reviewItem.config.body,
    invalidateQuery: true,
    permissions: reviewItem.config.permissions,
  })
  .patch("/item-sources", verifyItemSource.handler, {
    body: verifyItemSource.config.body,
    invalidateQuery: true,
    permissions: verifyItemSource.config.permissions,
  })
  .patch("/items", updateItem.handler, {
    body: updateItem.config.body,
    invalidateQuery: true,
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
