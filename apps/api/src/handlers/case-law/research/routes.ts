import Elysia from "elysia";

import lookupResearchAnswers from "@/api/handlers/case-law/research/answers-lookup";
import runResearchAnswers from "@/api/handlers/case-law/research/answers-run";
import createResearchColumn from "@/api/handlers/case-law/research/columns-create";
import deleteResearchColumn from "@/api/handlers/case-law/research/columns-delete";
import reorderResearchColumns from "@/api/handlers/case-law/research/columns-reorder";
import updateResearchColumn from "@/api/handlers/case-law/research/columns-update";
import createResearchTable from "@/api/handlers/case-law/research/create";
import deleteResearchTableDecision from "@/api/handlers/case-law/research/decisions-delete";
import setResearchTableDecision from "@/api/handlers/case-law/research/decisions-set";
import deleteResearchTable from "@/api/handlers/case-law/research/delete";
import readResearchTable from "@/api/handlers/case-law/research/get";
import listResearchTables from "@/api/handlers/case-law/research/list";
import updateResearchTable from "@/api/handlers/case-law/research/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

/** Organization-scoped: a research table belongs to a member, not a matter. */
export const caseLawResearchRoute = new Elysia({ prefix: "/case/research" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listResearchTables.handler, {
    query: listResearchTables.config.query,
    permissions: listResearchTables.config.permissions,
  })
  .post("/", createResearchTable.handler, {
    body: createResearchTable.config.body,
    permissions: createResearchTable.config.permissions,
  })
  .get("/:tableId", readResearchTable.handler, {
    params: readResearchTable.config.params,
    permissions: readResearchTable.config.permissions,
  })
  .patch("/:tableId", updateResearchTable.handler, {
    body: updateResearchTable.config.body,
    params: updateResearchTable.config.params,
    permissions: updateResearchTable.config.permissions,
  })
  .delete("/:tableId", deleteResearchTable.handler, {
    params: deleteResearchTable.config.params,
    permissions: deleteResearchTable.config.permissions,
  })
  .put("/:tableId/decisions", setResearchTableDecision.handler, {
    body: setResearchTableDecision.config.body,
    params: setResearchTableDecision.config.params,
    permissions: setResearchTableDecision.config.permissions,
  })
  .delete(
    "/:tableId/decisions/:decisionId",
    deleteResearchTableDecision.handler,
    {
      params: deleteResearchTableDecision.config.params,
      permissions: deleteResearchTableDecision.config.permissions,
    },
  )
  .post("/:tableId/columns", createResearchColumn.handler, {
    body: createResearchColumn.config.body,
    params: createResearchColumn.config.params,
    permissions: createResearchColumn.config.permissions,
  })
  .put("/:tableId/columns/order", reorderResearchColumns.handler, {
    body: reorderResearchColumns.config.body,
    params: reorderResearchColumns.config.params,
    permissions: reorderResearchColumns.config.permissions,
  })
  .patch("/:tableId/columns/:columnId", updateResearchColumn.handler, {
    body: updateResearchColumn.config.body,
    params: updateResearchColumn.config.params,
    permissions: updateResearchColumn.config.permissions,
  })
  .delete("/:tableId/columns/:columnId", deleteResearchColumn.handler, {
    params: deleteResearchColumn.config.params,
    permissions: deleteResearchColumn.config.permissions,
  })
  .post("/:tableId/answers/lookup", lookupResearchAnswers.handler, {
    body: lookupResearchAnswers.config.body,
    params: lookupResearchAnswers.config.params,
    permissions: lookupResearchAnswers.config.permissions,
  })
  .post("/:tableId/answers/run", runResearchAnswers.handler, {
    body: runResearchAnswers.config.body,
    params: runResearchAnswers.config.params,
    permissions: runResearchAnswers.config.permissions,
  });
