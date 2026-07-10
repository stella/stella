import Elysia from "elysia";

import batchDelete from "@/api/handlers/time-entries/batch-delete";
import batchUpdate from "@/api/handlers/time-entries/batch-update";
import createTimeEntry from "@/api/handlers/time-entries/create";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete-by-id";
import exportCsv from "@/api/handlers/time-entries/export-csv";
import exportLedes from "@/api/handlers/time-entries/export-ledes";
import exportPdf from "@/api/handlers/time-entries/export-pdf";
import readTimeEntries from "@/api/handlers/time-entries/read";
import readTimeEntryById from "@/api/handlers/time-entries/read-by-id";
import splitEntry from "@/api/handlers/time-entries/split";
import timerStart from "@/api/handlers/time-entries/timer-start";
import timerStop from "@/api/handlers/time-entries/timer-stop";
import updateTimeEntryById from "@/api/handlers/time-entries/update-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const timeEntriesRoute = new Elysia({
  prefix: "/time-entries/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readTimeEntries.handler, {
    permissions: readTimeEntries.config.permissions,
    query: readTimeEntries.config.query,
  })
  .get("/:id", readTimeEntryById.handler, {
    params: readTimeEntryById.config.params,
    permissions: readTimeEntryById.config.permissions,
  })
  .put("/", createTimeEntry.handler, {
    body: createTimeEntry.config.body,
    invalidateQuery: true,
    permissions: createTimeEntry.config.permissions,
  })
  .patch("/", updateTimeEntryById.handler, {
    body: updateTimeEntryById.config.body,
    invalidateQuery: true,
    permissions: updateTimeEntryById.config.permissions,
  })
  .delete("/", deleteTimeEntryById.handler, {
    body: deleteTimeEntryById.config.body,
    invalidateQuery: true,
    permissions: deleteTimeEntryById.config.permissions,
  })
  .post("/timer/start", timerStart.handler, {
    body: timerStart.config.body,
    invalidateQuery: true,
    permissions: timerStart.config.permissions,
  })
  .post("/timer/stop", timerStop.handler, {
    invalidateQuery: true,
    permissions: timerStop.config.permissions,
  })
  .post("/batch", batchUpdate.handler, {
    body: batchUpdate.config.body,
    invalidateQuery: true,
    permissions: batchUpdate.config.permissions,
  })
  .delete("/batch", batchDelete.handler, {
    body: batchDelete.config.body,
    invalidateQuery: true,
    permissions: batchDelete.config.permissions,
  })
  .post("/split", splitEntry.handler, {
    body: splitEntry.config.body,
    invalidateQuery: true,
    permissions: splitEntry.config.permissions,
  })
  .get("/export/csv", exportCsv.handler, {
    permissions: exportCsv.config.permissions,
    query: exportCsv.config.query,
  })
  .get("/export/ledes", exportLedes.handler, {
    permissions: exportLedes.config.permissions,
    query: exportLedes.config.query,
  })
  .get("/export/pdf", exportPdf.handler, {
    permissions: exportPdf.config.permissions,
    query: exportPdf.config.query,
  });
