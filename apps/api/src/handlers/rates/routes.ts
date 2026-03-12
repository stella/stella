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
  .get(
    "/",
    async (ctx) =>
      await readRateTablesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readRateTablesQuerySchema,
    },
  )
  .put(
    "/",
    async (ctx) =>
      await createRateTableHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["create"] },
      invalidateQuery: true,
      body: createRateTableBodySchema,
    },
  )
  .patch(
    "/",
    async (ctx) =>
      await updateRateTableHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["update"] },
      invalidateQuery: true,
      body: updateRateTableBodySchema,
    },
  )
  .delete(
    "/",
    async (ctx) =>
      await deleteRateTableHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["delete"] },
      invalidateQuery: true,
      body: deleteRateTableBodySchema,
    },
  )
  // Rate resolution
  .get(
    "/resolve",
    async (ctx) =>
      await resolveRateHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: resolveRateQuerySchema,
    },
  )
  // Rate entries
  .get(
    "/:rateTableId/entries",
    async (ctx) =>
      await readRateEntriesHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readRateEntriesQuerySchema,
    },
  )
  .put(
    "/:rateTableId/entries",
    async (ctx) =>
      await createRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["create"] },
      invalidateQuery: true,
      body: createRateEntryBodySchema,
    },
  )
  .patch(
    "/:rateTableId/entries",
    async (ctx) =>
      await updateRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["update"] },
      invalidateQuery: true,
      body: updateRateEntryBodySchema,
    },
  )
  .delete(
    "/:rateTableId/entries",
    async (ctx) =>
      await deleteRateEntryHandler({
        workspaceId: ctx.workspaceId,
        rateTableId: ctx.params.rateTableId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { rate: ["delete"] },
      invalidateQuery: true,
      body: deleteRateEntryBodySchema,
    },
  );
