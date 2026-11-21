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
import { mount, routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const listsRoute = mount(
  [
    createListVerificationRoutes(),
    routes({
      "/": { GET: readLists, PUT: createList, PATCH: updateList },
      "/sections": { POST: createSection },
      "/columns": { POST: createColumn },
      "/generations": { POST: createGeneration },
      "/generation-candidates": { POST: submitGenerationCandidates },
      "/generation-candidates/accept": { POST: acceptGenerationCandidate },
      "/generation-candidates/reject": { POST: rejectGenerationCandidate },
      "/item-sources": { POST: createItemSource },
      "/item-comments": { POST: createItemComment },
      "/item-reviews": { POST: reviewItem },
      "/items": { PATCH: updateItem },
      "/:listId/generations/:runId/candidates": {
        GET: readGenerationCandidates,
      },
      "/:listId/generations": { GET: readGenerations },
      "/:listId": { GET: readListById },
      "/:listId/items": { GET: readListItems },
      "/:listId/items/:itemEntityId/activity": { GET: readItemActivity },
      "/:listId/items/:itemEntityId/sources": { GET: readItemSources },
    }),
  ],
  {
    prefix: "/lists/:workspaceId",
    middleware: [deploymentFeatureGate("FEATURE_LEGAL_LISTS")],
  },
);
