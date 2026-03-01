import Elysia from "elysia";

import {
  createTimeEntryBodySchema,
  createTimeEntryHandler,
} from "@/api/handlers/time-entries/create";
import {
  deleteTimeEntryBodySchema,
  deleteTimeEntryByIdHandler,
} from "@/api/handlers/time-entries/delete-by-id";
import {
  readTimeEntriesHandler,
  readTimeEntriesQuerySchema,
} from "@/api/handlers/time-entries/read";
import { readTimeEntryByIdHandler } from "@/api/handlers/time-entries/read-by-id";
import {
  timerStartBodySchema,
  timerStartHandler,
} from "@/api/handlers/time-entries/timer-start";
import { timerStopHandler } from "@/api/handlers/time-entries/timer-stop";
import {
  updateTimeEntryBodySchema,
  updateTimeEntryByIdHandler,
} from "@/api/handlers/time-entries/update-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const timeEntriesRoute = new Elysia({
  prefix: "/time-entries/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    (ctx) =>
      readTimeEntriesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: readTimeEntriesQuerySchema,
    },
  )
  .get("/:id", (ctx) =>
    readTimeEntryByIdHandler({
      workspaceId: ctx.workspaceId,
      id: ctx.params.id,
    }),
  )
  .put(
    "/",
    (ctx) =>
      createTimeEntryHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createTimeEntryBodySchema,
    },
  )
  .patch(
    "/",
    (ctx) =>
      updateTimeEntryByIdHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: updateTimeEntryBodySchema,
    },
  )
  .delete(
    "/",
    (ctx) =>
      deleteTimeEntryByIdHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteTimeEntryBodySchema,
    },
  )
  .post(
    "/timer/start",
    (ctx) =>
      timerStartHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: timerStartBodySchema,
    },
  )
  .post(
    "/timer/stop",
    (ctx) =>
      timerStopHandler({
        userId: ctx.user.id,
      }),
    {
      invalidateQuery: true,
    },
  );
