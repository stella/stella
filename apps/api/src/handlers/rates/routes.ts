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
    permissions: readRateTables.config.permissions,
    query: readRateTables.config.query,
  })
  .put("/", createRateTable.handler, {
    body: createRateTable.config.body,
    invalidateQuery: true,
    permissions: createRateTable.config.permissions,
  })
  .patch("/", updateRateTable.handler, {
    body: updateRateTable.config.body,
    invalidateQuery: true,
    permissions: updateRateTable.config.permissions,
  })
  .delete("/", deleteRateTable.handler, {
    body: deleteRateTable.config.body,
    invalidateQuery: true,
    permissions: deleteRateTable.config.permissions,
  })
  // Rate resolution
  .get("/resolve", resolveRate.handler, {
    permissions: resolveRate.config.permissions,
    query: resolveRate.config.query,
  })
  // Rate entries
  .get("/:rateTableId/entries", readRateEntries.handler, {
    params: readRateEntries.config.params,
    permissions: readRateEntries.config.permissions,
    query: readRateEntries.config.query,
  })
  .put("/:rateTableId/entries", createRateEntry.handler, {
    body: createRateEntry.config.body,
    invalidateQuery: true,
    params: createRateEntry.config.params,
    permissions: createRateEntry.config.permissions,
  })
  .patch("/:rateTableId/entries", updateRateEntry.handler, {
    body: updateRateEntry.config.body,
    invalidateQuery: true,
    params: updateRateEntry.config.params,
    permissions: updateRateEntry.config.permissions,
  })
  .delete("/:rateTableId/entries", deleteRateEntry.handler, {
    body: deleteRateEntry.config.body,
    invalidateQuery: true,
    params: deleteRateEntry.config.params,
    permissions: deleteRateEntry.config.permissions,
  });
