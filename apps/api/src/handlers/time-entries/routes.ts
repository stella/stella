import { Result } from "better-result";
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
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

const exportCsv = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: exportCsvQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportCsvHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const exportLedes = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: exportLedesQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportLedesHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const exportPdf = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    query: exportPdfQuerySchema,
  } satisfies HandlerConfig,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportPdfHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

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
