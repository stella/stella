import Elysia from "elysia";

import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import runResearchAnswers from "@/api/handlers/case-law/research/answers-run";
import createResearchColumn from "@/api/handlers/case-law/research/columns-create";
import deleteResearchColumn from "@/api/handlers/case-law/research/columns-delete";
import listResearchColumns from "@/api/handlers/case-law/research/columns-list";
import reorderResearchColumns from "@/api/handlers/case-law/research/columns-reorder";
import suggestResearchColumnPrompt from "@/api/handlers/case-law/research/columns-suggest-prompt";
import updateResearchColumn from "@/api/handlers/case-law/research/columns-update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/**
 * Organization-scoped. Question columns and their answers belong to the
 * organization: one answer serves every search that surfaces the decision.
 */
export const caseLawResearchRoute = new Elysia({ prefix: "/case/research" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/columns",
    {
      permissions: listResearchColumns.config.permissions,
    },
    listResearchColumns.handler,
  )
  .post(
    "/columns",
    {
      body: createResearchColumn.config.body,
      permissions: createResearchColumn.config.permissions,
    },
    createResearchColumn.handler,
  )
  .put(
    "/columns/order",
    {
      body: reorderResearchColumns.config.body,
      permissions: reorderResearchColumns.config.permissions,
    },
    reorderResearchColumns.handler,
  )
  .post(
    "/columns/suggest-prompt",
    {
      body: suggestResearchColumnPrompt.config.body,
      permissions: suggestResearchColumnPrompt.config.permissions,
    },
    suggestResearchColumnPrompt.handler,
  )
  .patch(
    "/columns/:columnId",
    {
      body: updateResearchColumn.config.body,
      params: updateResearchColumn.config.params,
      permissions: updateResearchColumn.config.permissions,
    },
    updateResearchColumn.handler,
  )
  .delete(
    "/columns/:columnId",
    {
      params: deleteResearchColumn.config.params,
      permissions: deleteResearchColumn.config.permissions,
    },
    deleteResearchColumn.handler,
  )
  .post(
    "/answers/lookup",
    {
      body: lookupResearchAnswers.config.body,
      permissions: lookupResearchAnswers.config.permissions,
    },
    lookupResearchAnswers.handler,
  )
  .post(
    "/answers/run",
    {
      body: runResearchAnswers.config.body,
      permissions: runResearchAnswers.config.permissions,
    },
    runResearchAnswers.handler,
  );
