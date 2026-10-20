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
  .get(
    "/",
    {
      permissions: readLists.config.permissions,
      query: readLists.config.query,
    },
    readLists.handler,
  )
  .put(
    "/",
    {
      body: createList.config.body,
      permissions: createList.config.permissions,
    },
    createList.handler,
  )
  .patch(
    "/",
    {
      body: updateList.config.body,
      permissions: updateList.config.permissions,
    },
    updateList.handler,
  )
  .post(
    "/sections",
    {
      body: createSection.config.body,
      permissions: createSection.config.permissions,
    },
    createSection.handler,
  )
  .post(
    "/columns",
    {
      body: createColumn.config.body,
      permissions: createColumn.config.permissions,
    },
    createColumn.handler,
  )
  .post(
    "/generations",
    {
      body: createGeneration.config.body,
      permissions: createGeneration.config.permissions,
    },
    createGeneration.handler,
  )
  .post(
    "/generation-candidates",
    {
      body: submitGenerationCandidates.config.body,
      permissions: submitGenerationCandidates.config.permissions,
    },
    submitGenerationCandidates.handler,
  )
  .post(
    "/generation-candidates/accept",
    {
      body: acceptGenerationCandidate.config.body,
      permissions: acceptGenerationCandidate.config.permissions,
    },
    acceptGenerationCandidate.handler,
  )
  .post(
    "/generation-candidates/reject",
    {
      body: rejectGenerationCandidate.config.body,
      permissions: rejectGenerationCandidate.config.permissions,
    },
    rejectGenerationCandidate.handler,
  )
  .post(
    "/item-sources",
    {
      body: createItemSource.config.body,
      permissions: createItemSource.config.permissions,
    },
    createItemSource.handler,
  )
  .post(
    "/item-comments",
    {
      body: createItemComment.config.body,
      permissions: createItemComment.config.permissions,
    },
    createItemComment.handler,
  )
  .post(
    "/item-reviews",
    {
      body: reviewItem.config.body,
      permissions: reviewItem.config.permissions,
    },
    reviewItem.handler,
  )
  .patch(
    "/items",
    {
      body: updateItem.config.body,
      permissions: updateItem.config.permissions,
    },
    updateItem.handler,
  )
  .get(
    "/:listId/generations/:runId/candidates",
    {
      params: readGenerationCandidates.config.params,
      permissions: readGenerationCandidates.config.permissions,
      query: readGenerationCandidates.config.query,
    },
    readGenerationCandidates.handler,
  )
  .get(
    "/:listId/generations",
    {
      params: readGenerations.config.params,
      permissions: readGenerations.config.permissions,
      query: readGenerations.config.query,
    },
    readGenerations.handler,
  )
  .get(
    "/:listId",
    {
      params: readListById.config.params,
      permissions: readListById.config.permissions,
    },
    readListById.handler,
  )
  .get(
    "/:listId/items",
    {
      params: readListItems.config.params,
      permissions: readListItems.config.permissions,
      query: readListItems.config.query,
    },
    readListItems.handler,
  )
  .get(
    "/:listId/items/:itemEntityId/activity",
    {
      params: readItemActivity.config.params,
      permissions: readItemActivity.config.permissions,
      query: readItemActivity.config.query,
    },
    readItemActivity.handler,
  )
  .get(
    "/:listId/items/:itemEntityId/sources",
    {
      params: readItemSources.config.params,
      permissions: readItemSources.config.permissions,
      query: readItemSources.config.query,
    },
    readItemSources.handler,
  );
