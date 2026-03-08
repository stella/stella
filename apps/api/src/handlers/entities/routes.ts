import Elysia, { t } from "elysia";

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
import {
  renameEntityBodySchema,
  renameEntityHandler,
} from "@/api/handlers/entities/rename";
import {
  uploadEntityBodySchema,
  uploadEntityHandler,
} from "@/api/handlers/entities/upload";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const entitiesRoute = new Elysia({
  prefix: "/entities/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/",
    (ctx) =>
      createEntitiesHandler({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createEntityBodySchema,
    },
  )
  .post(
    "/upload",
    (ctx) =>
      uploadEntityHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: uploadEntityBodySchema,
    },
  )
  .get("/", (ctx) =>
    readEntitiesHandler({
      workspaceId: ctx.workspaceId,
    }),
  )
  .delete(
    "/",
    (ctx) =>
      deleteEntitiesHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteEntitiesBodySchema,
    },
  )
  .patch(
    "/move",
    (ctx) =>
      moveEntityHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: moveEntityBodySchema,
    },
  )
  .patch(
    "/rename",
    (ctx) =>
      renameEntityHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: renameEntityBodySchema,
    },
  )
  .post(
    "/duplicate",
    (ctx) =>
      duplicateEntityHandler({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: duplicateEntityBodySchema,
    },
  )
  .post(
    "/check-stamp",
    (ctx) =>
      checkStampHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    {
      body: checkStampBodySchema,
    },
  )
  .get(
    "/zip/:entityId",
    (ctx) =>
      downloadZipHandler({
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
  );
