import Elysia, { t } from "elysia";

import {
  createCategoryBodySchema,
  createCategoryHandler,
  deleteCategoryHandler,
  listCategoriesHandler,
  updateCategoryBodySchema,
  updateCategoryHandler,
} from "@/api/handlers/clauses/categories";
import {
  createClauseBodySchema,
  createClauseHandler,
} from "@/api/handlers/clauses/create";
import { deleteClauseHandler } from "@/api/handlers/clauses/delete";
import {
  exportHandler,
  exportQuerySchema,
} from "@/api/handlers/clauses/export";
import { importBodySchema, importHandler } from "@/api/handlers/clauses/import";
import {
  getClauseHandler,
  getClauseVersionHandler,
  listClausesHandler,
  listClausesQuerySchema,
} from "@/api/handlers/clauses/read";
import {
  updateClauseBodySchema,
  updateClauseHandler,
} from "@/api/handlers/clauses/update";
import {
  createVariantBodySchema,
  createVariantHandler,
  deleteVariantHandler,
  listVariantsHandler,
  updateVariantBodySchema,
  updateVariantHandler,
} from "@/api/handlers/clauses/variants";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";

// ── Categories ──────────────────────────────────────

export const clauseCategoriesRoute = new Elysia({
  prefix: "/clause-categories",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", (ctx) =>
    listCategoriesHandler({
      organizationId: ctx.session.activeOrganizationId,
    }),
  )
  .put(
    "/",
    (ctx) =>
      createCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["create"] },
      body: createCategoryBodySchema,
    },
  )
  .post(
    "/:categoryId",
    (ctx) =>
      updateCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["update"] },
      params: t.Object({ categoryId: tNanoid }),
      body: updateCategoryBodySchema,
    },
  )
  .delete(
    "/:categoryId",
    (ctx) =>
      deleteCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
      }),
    {
      permissions: { clause: ["delete"] },
      params: t.Object({ categoryId: tNanoid }),
    },
  );

// ── Clauses ─────────────────────────────────────────

export const clausesRoute = new Elysia({
  prefix: "/clauses",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    (ctx) =>
      listClausesHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: listClausesQuerySchema },
  )
  .put(
    "/",
    (ctx) =>
      createClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["create"] },
      body: createClauseBodySchema,
    },
  )
  .get(
    "/export",
    (ctx) =>
      exportHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
      }),
    { query: exportQuerySchema },
  )
  .put(
    "/import",
    (ctx) =>
      importHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["create"] },
      body: importBodySchema,
    },
  )
  .get(
    "/:clauseId",
    (ctx) =>
      getClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
      }),
    { params: t.Object({ clauseId: tNanoid }) },
  )
  .post(
    "/:clauseId",
    (ctx) =>
      updateClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["update"] },
      params: t.Object({ clauseId: tNanoid }),
      body: updateClauseBodySchema,
    },
  )
  .delete(
    "/:clauseId",
    (ctx) =>
      deleteClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
      }),
    {
      permissions: { clause: ["delete"] },
      params: t.Object({ clauseId: tNanoid }),
    },
  )
  // ── Versions ───────────────────────────────────
  .get(
    "/:clauseId/versions/:versionId",
    (ctx) =>
      getClauseVersionHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        versionId: ctx.params.versionId,
      }),
    {
      params: t.Object({
        clauseId: tNanoid,
        versionId: tNanoid,
      }),
    },
  )
  // ── Variants ────────────────────────────────────
  .get(
    "/:clauseId/variants",
    (ctx) =>
      listVariantsHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
      }),
    { params: t.Object({ clauseId: tNanoid }) },
  )
  .put(
    "/:clauseId/variants",
    (ctx) =>
      createVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["create"] },
      params: t.Object({ clauseId: tNanoid }),
      body: createVariantBodySchema,
    },
  )
  .post(
    "/:clauseId/variants/:variantId",
    (ctx) =>
      updateVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        variantId: ctx.params.variantId,
        body: ctx.body,
      }),
    {
      permissions: { clause: ["update"] },
      params: t.Object({
        clauseId: tNanoid,
        variantId: tNanoid,
      }),
      body: updateVariantBodySchema,
    },
  )
  .delete(
    "/:clauseId/variants/:variantId",
    (ctx) =>
      deleteVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        variantId: ctx.params.variantId,
      }),
    {
      permissions: { clause: ["delete"] },
      params: t.Object({
        clauseId: tNanoid,
        variantId: tNanoid,
      }),
    },
  );
