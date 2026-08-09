import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createRateTable from "@/api/handlers/rates/create";
import deleteRateTable from "@/api/handlers/rates/delete";
import createRateEntry from "@/api/handlers/rates/entries-create";
import deleteRateEntry from "@/api/handlers/rates/entries-delete";
import readRateEntries from "@/api/handlers/rates/entries-read";
import updateRateEntry from "@/api/handlers/rates/entries-update";
import readRateTables from "@/api/handlers/rates/list";
import resolveRate from "@/api/handlers/rates/resolve";
import updateRateTable from "@/api/handlers/rates/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const rateRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.RATE_TABLE,
  RESOURCE_TYPE.RATE_ENTRY,
]);

export const ratesRoute = new Elysia({
  prefix: "/rates/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
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
    resourceSetUpdated: rateRealtimeUpdates,
    permissions: createRateTable.config.permissions,
  })
  .patch("/", updateRateTable.handler, {
    body: updateRateTable.config.body,
    resourceSetUpdated: rateRealtimeUpdates,
    permissions: updateRateTable.config.permissions,
  })
  .delete("/", deleteRateTable.handler, {
    body: deleteRateTable.config.body,
    resourceSetUpdated: rateRealtimeUpdates,
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
    resourceSetUpdated: rateRealtimeUpdates,
    params: createRateEntry.config.params,
    permissions: createRateEntry.config.permissions,
  })
  .patch("/:rateTableId/entries", updateRateEntry.handler, {
    body: updateRateEntry.config.body,
    resourceSetUpdated: rateRealtimeUpdates,
    params: updateRateEntry.config.params,
    permissions: updateRateEntry.config.permissions,
  })
  .delete("/:rateTableId/entries", deleteRateEntry.handler, {
    body: deleteRateEntry.config.body,
    resourceSetUpdated: rateRealtimeUpdates,
    params: deleteRateEntry.config.params,
    permissions: deleteRateEntry.config.permissions,
  });
