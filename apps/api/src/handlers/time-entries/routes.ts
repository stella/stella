import Elysia from "elysia";

import batchDelete from "@/api/handlers/time-entries/batch-delete";
import batchUpdate from "@/api/handlers/time-entries/batch-update";
import createTimeEntry from "@/api/handlers/time-entries/create";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete-by-id";
import {
  exportCsvHandler,
  exportCsvQuerySchema,
} from "@/api/handlers/time-entries/export-csv";
import {
  exportLedesHandler,
  exportLedesQuerySchema,
} from "@/api/handlers/time-entries/export-ledes";
import {
  exportPdfHandler,
  exportPdfQuerySchema,
} from "@/api/handlers/time-entries/export-pdf";
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
    query: readTimeEntries.config.query,
  })
  .get("/:id", readTimeEntryById.handler, {
    params: readTimeEntryById.config.params,
  })
  .put("/", createTimeEntry.handler, {
    invalidateQuery: true,
    body: createTimeEntry.config.body,
  })
  .patch("/", updateTimeEntryById.handler, {
    invalidateQuery: true,
    body: updateTimeEntryById.config.body,
  })
  .delete("/", deleteTimeEntryById.handler, {
    invalidateQuery: true,
    body: deleteTimeEntryById.config.body,
  })
  .post("/timer/start", timerStart.handler, {
    invalidateQuery: true,
    body: timerStart.config.body,
  })
  .post("/timer/stop", timerStop.handler, {
    invalidateQuery: true,
  })
  .post("/batch", batchUpdate.handler, {
    invalidateQuery: true,
    body: batchUpdate.config.body,
  })
  .delete("/batch", batchDelete.handler, {
    invalidateQuery: true,
    body: batchDelete.config.body,
  })
  .post("/split", splitEntry.handler, {
    invalidateQuery: true,
    body: splitEntry.config.body,
  })
  .get(
    "/export/csv",
    async (ctx) =>
      await exportCsvHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: exportCsvQuerySchema,
    },
  )
  .get(
    "/export/ledes",
    async (ctx) =>
      await exportLedesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: exportLedesQuerySchema,
    },
  )
  .get(
    "/export/pdf",
    async (ctx) =>
      await exportPdfHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: exportPdfQuerySchema,
    },
  );
