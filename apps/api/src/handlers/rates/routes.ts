import Elysia from "elysia";

import createRateTable from "@/api/handlers/rates/create";
import deleteRateTable from "@/api/handlers/rates/delete";
import createRateEntry from "@/api/handlers/rates/entries-create";
import deleteRateEntry from "@/api/handlers/rates/entries-delete";
import readRateEntries from "@/api/handlers/rates/entries-read";
import updateRateEntry from "@/api/handlers/rates/entries-update";
import readRateTables from "@/api/handlers/rates/read";
import resolveRate from "@/api/handlers/rates/resolve";
import updateRateTable from "@/api/handlers/rates/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const ratesRoute = new Elysia({
  prefix: "/rates/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  // Rate tables
  .get("/", readRateTables.handler, {
    query: readRateTables.config.query,
  })
  .put("/", createRateTable.handler, {
    invalidateQuery: true,
    body: createRateTable.config.body,
  })
  .patch("/", updateRateTable.handler, {
    invalidateQuery: true,
    body: updateRateTable.config.body,
  })
  .delete("/", deleteRateTable.handler, {
    invalidateQuery: true,
    body: deleteRateTable.config.body,
  })
  // Rate resolution
  .get("/resolve", resolveRate.handler, {
    query: resolveRate.config.query,
  })
  // Rate entries
  .get("/:rateTableId/entries", readRateEntries.handler, {
    params: readRateEntries.config.params,
    query: readRateEntries.config.query,
  })
  .put("/:rateTableId/entries", createRateEntry.handler, {
    params: createRateEntry.config.params,
    invalidateQuery: true,
    body: createRateEntry.config.body,
  })
  .patch("/:rateTableId/entries", updateRateEntry.handler, {
    params: updateRateEntry.config.params,
    invalidateQuery: true,
    body: updateRateEntry.config.body,
  })
  .delete("/:rateTableId/entries", deleteRateEntry.handler, {
    params: deleteRateEntry.config.params,
    invalidateQuery: true,
    body: deleteRateEntry.config.body,
  });
