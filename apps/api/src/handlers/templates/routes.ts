import Elysia, { t } from "elysia";

import {
  linkClauseBodySchema,
  linkClauseHandler,
  listTemplateClausesHandler,
  syncClauseHandler,
  unlinkClauseHandler,
} from "@/api/handlers/clauses/template-links";
import {
  createTemplateCategoryBodySchema,
  createTemplateCategoryHandler,
  deleteTemplateCategoryHandler,
  listTemplateCategoriesHandler,
  updateTemplateCategoryBodySchema,
  updateTemplateCategoryHandler,
} from "@/api/handlers/templates/categories";
import {
  createTemplateBodySchema,
  createTemplateHandler,
} from "@/api/handlers/templates/create";
import { deleteTemplateHandler } from "@/api/handlers/templates/delete";
import {
  discoverBodySchema,
  discoverHandler,
} from "@/api/handlers/templates/discover";
import {
  fillBodySchema,
  fillHandler,
  fillQuerySchema,
} from "@/api/handlers/templates/fill";
import {
  fillByIdBodySchema,
  fillByIdHandler,
  fillByIdQuerySchema,
} from "@/api/handlers/templates/fill-by-id";
import {
  fillPreviewBodySchema,
  fillPreviewHandler,
} from "@/api/handlers/templates/fill-preview";
import { getTemplateHandler } from "@/api/handlers/templates/get";
import {
  listTemplatesHandler,
  listTemplatesQuerySchema,
} from "@/api/handlers/templates/list";
import {
  manifestBodySchema,
  manifestHandler,
} from "@/api/handlers/templates/manifest";
import { previewTemplateHandler } from "@/api/handlers/templates/preview";
import {
  updateTemplateBodySchema,
  updateTemplateHandler,
} from "@/api/handlers/templates/update";
import {
  getTemplateVersionHandler,
  listTemplateVersionsHandler,
} from "@/api/handlers/templates/versions";
import { authMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";

export const templatesRoute = new Elysia({
  prefix: "/templates",
})
  .use(authMacro)
  .guard({
    validateAuth: true,
  })
  // ── Existing transient endpoints ───────────────────
  .post(
    "/discover",
    (ctx) =>
      discoverHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    { body: discoverBodySchema },
  )
  .post(
    "/fill",
    (ctx) =>
      fillHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
        query: ctx.query,
      }),
    { body: fillBodySchema, query: fillQuerySchema },
  )
  .post(
    "/manifest",
    (ctx) =>
      manifestHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    { body: manifestBodySchema },
  )
  // ── CRUD endpoints ─────────────────────────────────
  .get(
    "/",
    (ctx) =>
      listTemplatesHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: listTemplatesQuerySchema },
  )
  .put(
    "/",
    (ctx) =>
      createTemplateHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    { body: createTemplateBodySchema },
  )
  .get(
    "/:templateId/preview",
    (ctx) =>
      previewTemplateHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
      }),
    { params: t.Object({ templateId: tNanoid }) },
  )
  .post(
    "/:templateId/fill-preview",
    (ctx) =>
      fillPreviewHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
        body: ctx.body,
      }),
    {
      params: t.Object({ templateId: tNanoid }),
      body: fillPreviewBodySchema,
    },
  )
  .post(
    "/:templateId/fill",
    (ctx) =>
      fillByIdHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        templateId: ctx.params.templateId,
        body: ctx.body,
        query: ctx.query,
      }),
    {
      params: t.Object({ templateId: tNanoid }),
      body: fillByIdBodySchema,
      query: fillByIdQuerySchema,
    },
  )
  .get(
    "/:templateId",
    (ctx) =>
      getTemplateHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
      }),
    { params: t.Object({ templateId: tNanoid }) },
  )
  .post(
    "/:templateId",
    (ctx) =>
      updateTemplateHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        templateId: ctx.params.templateId,
        body: ctx.body,
      }),
    {
      params: t.Object({ templateId: tNanoid }),
      body: updateTemplateBodySchema,
    },
  )
  .delete(
    "/:templateId",
    (ctx) =>
      deleteTemplateHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
      }),
    { params: t.Object({ templateId: tNanoid }) },
  )
  // ── Versions ──────────────────────────────────────
  .get(
    "/:templateId/versions",
    (ctx) =>
      listTemplateVersionsHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
      }),
    { params: t.Object({ templateId: tNanoid }) },
  )
  .get(
    "/:templateId/versions/:versionId",
    (ctx) =>
      getTemplateVersionHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
        versionId: ctx.params.versionId,
      }),
    {
      params: t.Object({
        templateId: tNanoid,
        versionId: tNanoid,
      }),
    },
  )
  // ── Clause linking ──────────────────────────────────
  .get(
    "/:templateId/clauses",
    (ctx) =>
      listTemplateClausesHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
      }),
    { params: t.Object({ templateId: tNanoid }) },
  )
  .put(
    "/:templateId/clauses",
    (ctx) =>
      linkClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
        body: ctx.body,
      }),
    {
      params: t.Object({ templateId: tNanoid }),
      body: linkClauseBodySchema,
    },
  )
  .delete(
    "/:templateId/clauses/:linkId",
    (ctx) =>
      unlinkClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
        linkId: ctx.params.linkId,
      }),
    {
      params: t.Object({
        templateId: tNanoid,
        linkId: tNanoid,
      }),
    },
  )
  .post(
    "/:templateId/clauses/:linkId/sync",
    (ctx) =>
      syncClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        templateId: ctx.params.templateId,
        linkId: ctx.params.linkId,
      }),
    {
      params: t.Object({
        templateId: tNanoid,
        linkId: tNanoid,
      }),
    },
  );

// ── Template Categories ────────────────────────────

export const templateCategoriesRoute = new Elysia({
  prefix: "/template-categories",
})
  .use(authMacro)
  .guard({ validateAuth: true })
  .get("/", (ctx) =>
    listTemplateCategoriesHandler({
      organizationId: ctx.session.activeOrganizationId,
    }),
  )
  .put(
    "/",
    (ctx) =>
      createTemplateCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    { body: createTemplateCategoryBodySchema },
  )
  .post(
    "/:categoryId",
    (ctx) =>
      updateTemplateCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
        body: ctx.body,
      }),
    {
      params: t.Object({ categoryId: tNanoid }),
      body: updateTemplateCategoryBodySchema,
    },
  )
  .delete(
    "/:categoryId",
    (ctx) =>
      deleteTemplateCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
      }),
    { params: t.Object({ categoryId: tNanoid }) },
  );
