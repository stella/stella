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
  .get("/columns", listResearchColumns.handler, {
    permissions: listResearchColumns.config.permissions,
    accountAccess: listResearchColumns.config.accountAccess,
  })
  .post("/columns", createResearchColumn.handler, {
    body: createResearchColumn.config.body,
    permissions: createResearchColumn.config.permissions,
    accountAccess: createResearchColumn.config.accountAccess,
  })
  .put("/columns/order", reorderResearchColumns.handler, {
    body: reorderResearchColumns.config.body,
    permissions: reorderResearchColumns.config.permissions,
    accountAccess: reorderResearchColumns.config.accountAccess,
  })
  .post("/columns/suggest-prompt", suggestResearchColumnPrompt.handler, {
    body: suggestResearchColumnPrompt.config.body,
    permissions: suggestResearchColumnPrompt.config.permissions,
    accountAccess: suggestResearchColumnPrompt.config.accountAccess,
  })
  .patch("/columns/:columnId", updateResearchColumn.handler, {
    body: updateResearchColumn.config.body,
    params: updateResearchColumn.config.params,
    permissions: updateResearchColumn.config.permissions,
    accountAccess: updateResearchColumn.config.accountAccess,
  })
  .delete("/columns/:columnId", deleteResearchColumn.handler, {
    params: deleteResearchColumn.config.params,
    permissions: deleteResearchColumn.config.permissions,
    accountAccess: deleteResearchColumn.config.accountAccess,
  })
  .post("/answers/lookup", lookupResearchAnswers.handler, {
    body: lookupResearchAnswers.config.body,
    permissions: lookupResearchAnswers.config.permissions,
    accountAccess: lookupResearchAnswers.config.accountAccess,
  })
  .post("/answers/run", runResearchAnswers.handler, {
    body: runResearchAnswers.config.body,
    permissions: runResearchAnswers.config.permissions,
    accountAccess: runResearchAnswers.config.accountAccess,
  });
