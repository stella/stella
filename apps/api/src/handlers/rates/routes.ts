import Elysia from "elysia";

import {
  createRateTableBodySchema,
  createRateTableHandler,
} from "@/api/handlers/rates/create";
import {
  deleteRateTableBodySchema,
  deleteRateTableHandler,
} from "@/api/handlers/rates/delete";
import {
  createRateEntryBodySchema,
  createRateEntryHandler,
} from "@/api/handlers/rates/entries-create";
import {
  deleteRateEntryBodySchema,
  deleteRateEntryHandler,
} from "@/api/handlers/rates/entries-delete";
import {
  readRateEntriesHandler,
  readRateEntriesQuerySchema,
} from "@/api/handlers/rates/entries-read";
import {
  updateRateEntryBodySchema,
  updateRateEntryHandler,
} from "@/api/handlers/rates/entries-update";
import {
  readRateTablesHandler,
  readRateTablesQuerySchema,
} from "@/api/handlers/rates/read";
import {
  resolveRateHandler,
  resolveRateQuerySchema,
} from "@/api/handlers/rates/resolve";
import {
  updateRateTableBodySchema,
  updateRateTableHandler,
} from "@/api/handlers/rates/update";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const ratesRoute = new Elysia({
  prefix: "/rates/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  // Rate tables
  .get(
    "/",
    (ctx) =>
      readRateTablesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: readRateTablesQuerySchema,
    },
  )
  .put(
    "/",
    (ctx) =>
      createRateTableHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createRateTableBodySchema,
    },
  )
  .patch(
    "/",
    (ctx) =>
      updateRateTableHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: updateRateTableBodySchema,
    },
  )
  .delete(
    "/",
    (ctx) =>
      deleteRateTableHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteRateTableBodySchema,
    },
  )
  // Rate resolution
  .get(
    "/resolve",
    (ctx) =>
      resolveRateHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: resolveRateQuerySchema,
    },
  )
  // Rate entries
  .get(
    "/:rateTableId/entries",
    (ctx) =>
      readRateEntriesHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        query: ctx.query,
      }),
    {
      query: readRateEntriesQuerySchema,
    },
  )
  .put(
    "/:rateTableId/entries",
    (ctx) =>
      createRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createRateEntryBodySchema,
    },
  )
  .patch(
    "/:rateTableId/entries",
    (ctx) =>
      updateRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: updateRateEntryBodySchema,
    },
  )
  .delete(
    "/:rateTableId/entries",
    (ctx) =>
      deleteRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteRateEntryBodySchema,
    },
  );
