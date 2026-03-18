import Elysia, { status, t } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import {
  checkStampBodySchema,
  checkStampHandler,
} from "@/api/handlers/entities/check-stamp";
import {
  createEntitiesHandler,
  createEntityBodySchema,
} from "@/api/handlers/entities/create";
import {
  deleteEntitiesBodySchema,
  deleteEntitiesHandler,
} from "@/api/handlers/entities/delete";
import { downloadZipHandler } from "@/api/handlers/entities/download-zip";
import {
  duplicateEntityBodySchema,
  duplicateEntityHandler,
} from "@/api/handlers/entities/duplicate";
import {
  moveEntityBodySchema,
  moveEntityHandler,
} from "@/api/handlers/entities/move";
import { readEntitiesHandler } from "@/api/handlers/entities/read";
import { readEntityByIdHandler } from "@/api/handlers/entities/read-by-id";
import { readEntitySummariesHandler } from "@/api/handlers/entities/read-summaries";
import {
  renameEntityBodySchema,
  renameEntityHandler,
} from "@/api/handlers/entities/rename";
import {
  uploadEntityBodySchema,
  uploadEntityHandler,
} from "@/api/handlers/entities/upload";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";
import { API_RATE_LIMITS, LIMITS } from "@/api/lib/limits";
import { RedisRateLimitContext, scopedGenerator } from "@/api/lib/rate-limit";

const viewFilterConditionSchema = t.Union([
  t.Object({
    id: t.String(),
    field: t.Literal("kind"),
    op: t.Literal("in"),
    value: t.Array(
      t.Union([
        t.Literal("document"),
        t.Literal("folder"),
        t.Literal("task"),
        t.Literal("message"),
      ]),
    ),
  }),
  t.Object({
    id: t.String(),
    field: t.Literal("property"),
    propertyId: t.String({ minLength: 1 }),
    op: t.Union([
      t.Literal("eq"),
      t.Literal("neq"),
      t.Literal("contains"),
      t.Literal("is_empty"),
    ]),
    value: t.Optional(
      t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
    ),
  }),
  t.Object({
    id: t.String(),
    field: t.Literal("builtin"),
    builtinField: t.Union([t.Literal("status"), t.Literal("priority")]),
    op: t.Union([
      t.Literal("eq"),
      t.Literal("neq"),
      t.Literal("in"),
      t.Literal("is_empty"),
    ]),
    value: t.Optional(
      t.Union([t.String(), t.Array(t.String()), t.Undefined()]),
    ),
  }),
]);

const viewSortSchema = t.Object({
  propertyId: t.String({ minLength: 1 }),
  desc: t.Boolean(),
});

const readEntitiesBodySchema = t.Object({
  filters: t.Optional(t.Array(viewFilterConditionSchema)),
  sorts: t.Optional(t.Array(viewSortSchema)),
  page: t.Optional(t.Integer({ minimum: 1 })),
  pageSize: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesPageSizeMax,
    }),
  ),
});

export const entitiesRoute = new Elysia({
  prefix: "/entities/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
      generator: scopedGenerator("upload"),
      context: new RedisRateLimitContext(),
      skip: (req) =>
        !/\/entities\/[^/]+\/upload$/.test(new URL(req.url).pathname),
    }),
  )
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/",
    async (ctx) =>
      await createEntitiesHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["create"] },
      invalidateQuery: true,
      body: createEntityBodySchema,
    },
  )
  .post(
    "/upload",
    async (ctx) =>
      await uploadEntityHandler({
        scopedDb: ctx.scopedDb,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["create"] },
      invalidateQuery: true,
      body: uploadEntityBodySchema,
    },
  )
  .post(
    "/query",
    async (ctx) =>
      await readEntitiesHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        filters: ctx.body.filters ?? [],
        sorts: ctx.body.sorts ?? [],
        page: ctx.body.page ?? 1,
        pageSize: ctx.body.pageSize ?? LIMITS.entitiesPageSizeDefault,
      }),
    {
      body: readEntitiesBodySchema,
    },
  )
  .delete(
    "/",
    async (ctx) =>
      await deleteEntitiesHandler({
        scopedDb: ctx.scopedDb,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["delete"] },
      invalidateQuery: true,
      body: deleteEntitiesBodySchema,
    },
  )
  .patch(
    "/move",
    async (ctx) =>
      await moveEntityHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: moveEntityBodySchema,
    },
  )
  .patch(
    "/rename",
    async (ctx) =>
      await renameEntityHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: renameEntityBodySchema,
    },
  )
  .post(
    "/duplicate",
    async (ctx) =>
      await duplicateEntityHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { entity: ["create"] },
      invalidateQuery: true,
      body: duplicateEntityBodySchema,
    },
  )
  .post(
    "/check-stamp",
    async (ctx) =>
      await checkStampHandler({
        scopedDb: ctx.scopedDb,
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    {
      body: checkStampBodySchema,
    },
  )
  .get(
    "/summaries",
    async (ctx) =>
      await readEntitySummariesHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        page: ctx.query.page ?? 1,
      }),
    {
      query: t.Object({
        page: t.Optional(t.Integer({ minimum: 1 })),
      }),
    },
  )
  .get(
    "/zip/:entityId",
    async (ctx) =>
      await downloadZipHandler({
        scopedDb: ctx.scopedDb,
        entityId: ctx.params.entityId,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
      }),
    {
      params: t.Object({
        workspaceId: t.String(),
        entityId: t.String(),
      }),
    },
  )
  .get(
    "/entity/:entityId",
    async (ctx) => {
      const result = await readEntityByIdHandler({
        scopedDb: ctx.scopedDb,
        workspaceId: ctx.workspaceId,
        entityId: ctx.params.entityId,
      });
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- result may be status Response
      if (!result) {
        return status(404, { message: "Entity not found" });
      }
      return result;
    },
    {
      params: t.Object({
        workspaceId: t.String(),
        entityId: t.String(),
      }),
    },
  );
