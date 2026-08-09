import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import batchDelete from "@/api/handlers/time-entries/batch-delete";
import batchUpdate from "@/api/handlers/time-entries/batch-update";
import createTimeEntry from "@/api/handlers/time-entries/create";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete";
import exportCsv from "@/api/handlers/time-entries/export-csv";
import exportLedes from "@/api/handlers/time-entries/export-ledes";
import exportPdf from "@/api/handlers/time-entries/export-pdf";
import readTimeEntryById from "@/api/handlers/time-entries/get";
import readTimeEntries from "@/api/handlers/time-entries/list";
import splitEntry from "@/api/handlers/time-entries/split";
import readTimeEntrySummary from "@/api/handlers/time-entries/summary/get";
import timerStart from "@/api/handlers/time-entries/timer-start";
import timerStop from "@/api/handlers/time-entries/timer-stop";
import updateTimeEntryById from "@/api/handlers/time-entries/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const timeEntryRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.TIME_ENTRY,
);

export const timeEntriesRoute = new Elysia({
  prefix: "/time-entries/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readTimeEntries.handler, {
    permissions: readTimeEntries.config.permissions,
    query: readTimeEntries.config.query,
  })
  .get("/summary", readTimeEntrySummary.handler, {
    permissions: readTimeEntrySummary.config.permissions,
    query: readTimeEntrySummary.config.query,
  })
  .get("/:id", readTimeEntryById.handler, {
    params: readTimeEntryById.config.params,
    permissions: readTimeEntryById.config.permissions,
  })
  .put("/", createTimeEntry.handler, {
    body: createTimeEntry.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: createTimeEntry.config.permissions,
  })
  .patch("/", updateTimeEntryById.handler, {
    body: updateTimeEntryById.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: updateTimeEntryById.config.permissions,
  })
  .delete("/", deleteTimeEntryById.handler, {
    body: deleteTimeEntryById.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: deleteTimeEntryById.config.permissions,
  })
  .post("/timer/start", timerStart.handler, {
    body: timerStart.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: timerStart.config.permissions,
  })
  .post("/timer/stop", timerStop.handler, {
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: timerStop.config.permissions,
  })
  .post("/batch", batchUpdate.handler, {
    body: batchUpdate.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: batchUpdate.config.permissions,
  })
  .delete("/batch", batchDelete.handler, {
    body: batchDelete.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
    permissions: batchDelete.config.permissions,
  })
  .post("/split", splitEntry.handler, {
    body: splitEntry.config.body,
    resourceSetUpdated: timeEntryRealtimeUpdates,
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
