import Elysia from "elysia";

import {
  batchDeleteBodySchema,
  batchDeleteHandler,
} from "@/api/handlers/time-entries/batch-delete";
import {
  batchUpdateBodySchema,
  batchUpdateHandler,
} from "@/api/handlers/time-entries/batch-update";
import {
  createTimeEntryBodySchema,
  createTimeEntryHandler,
} from "@/api/handlers/time-entries/create";
import {
  deleteTimeEntryBodySchema,
  deleteTimeEntryByIdHandler,
} from "@/api/handlers/time-entries/delete-by-id";
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
import {
  readTimeEntriesHandler,
  readTimeEntriesQuerySchema,
} from "@/api/handlers/time-entries/read";
import { readTimeEntryByIdHandler } from "@/api/handlers/time-entries/read-by-id";
import {
  splitEntryBodySchema,
  splitEntryHandler,
} from "@/api/handlers/time-entries/split";
import {
  timerStartBodySchema,
  timerStartHandler,
} from "@/api/handlers/time-entries/timer-start";
import { timerStopHandler } from "@/api/handlers/time-entries/timer-stop";
import {
  updateTimeEntryBodySchema,
  updateTimeEntryByIdHandler,
} from "@/api/handlers/time-entries/update-by-id";
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
  .get(
    "/",
    async (ctx) =>
      await readTimeEntriesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readTimeEntriesQuerySchema,
    },
  )
  .get(
    "/:id",
    async (ctx) =>
      await readTimeEntryByIdHandler({
        workspaceId: ctx.workspaceId,
        id: ctx.params.id,
        scopedDb: ctx.scopedDb,
      }),
  )
  .put(
    "/",
    async (ctx) =>
      await createTimeEntryHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["create"] },
      invalidateQuery: true,
      body: createTimeEntryBodySchema,
    },
  )
  .patch(
    "/",
    async (ctx) =>
      await updateTimeEntryByIdHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["update"] },
      invalidateQuery: true,
      body: updateTimeEntryBodySchema,
    },
  )
  .delete(
    "/",
    async (ctx) =>
      await deleteTimeEntryByIdHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["delete"] },
      invalidateQuery: true,
      body: deleteTimeEntryBodySchema,
    },
  )
  .post(
    "/timer/start",
    async (ctx) =>
      await timerStartHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["create"] },
      invalidateQuery: true,
      body: timerStartBodySchema,
    },
  )
  .post(
    "/timer/stop",
    async (ctx) =>
      await timerStopHandler({
        userId: ctx.user.id,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["update"] },
      invalidateQuery: true,
    },
  )
  .post(
    "/batch",
    async (ctx) =>
      await batchUpdateHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["update"] },
      invalidateQuery: true,
      body: batchUpdateBodySchema,
    },
  )
  .delete(
    "/batch",
    async (ctx) =>
      await batchDeleteHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["delete"] },
      invalidateQuery: true,
      body: batchDeleteBodySchema,
    },
  )
  .post(
    "/split",
    async (ctx) =>
      await splitEntryHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { timeEntry: ["update"] },
      invalidateQuery: true,
      body: splitEntryBodySchema,
    },
  )
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
