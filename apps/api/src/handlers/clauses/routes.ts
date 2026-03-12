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
  .get(
    "/",
    async (ctx) =>
      await listCategoriesHandler({
        organizationId: ctx.session.activeOrganizationId,
        scopedDb: ctx.scopedDb,
      }),
  )
  .put(
    "/",
    async (ctx) =>
      await createCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["create"] },
      body: createCategoryBodySchema,
    },
  )
  .post(
    "/:categoryId",
    async (ctx) =>
      await updateCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["update"] },
      params: t.Object({ categoryId: tNanoid }),
      body: updateCategoryBodySchema,
    },
  )
  .delete(
    "/:categoryId",
    async (ctx) =>
      await deleteCategoryHandler({
        organizationId: ctx.session.activeOrganizationId,
        categoryId: ctx.params.categoryId,
        scopedDb: ctx.scopedDb,
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
    async (ctx) =>
      await listClausesHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: listClausesQuerySchema },
  )
  .put(
    "/",
    async (ctx) =>
      await createClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["create"] },
      body: createClauseBodySchema,
    },
  )
  .get(
    "/export",
    async (ctx) =>
      await exportHandler({
        organizationId: ctx.session.activeOrganizationId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    { query: exportQuerySchema },
  )
  .put(
    "/import",
    async (ctx) =>
      await importHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["create"] },
      body: importBodySchema,
    },
  )
  .get(
    "/:clauseId",
    async (ctx) =>
      await getClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        scopedDb: ctx.scopedDb,
      }),
    { params: t.Object({ clauseId: tNanoid }) },
  )
  .post(
    "/:clauseId",
    async (ctx) =>
      await updateClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["update"] },
      params: t.Object({ clauseId: tNanoid }),
      body: updateClauseBodySchema,
    },
  )
  .delete(
    "/:clauseId",
    async (ctx) =>
      await deleteClauseHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["delete"] },
      params: t.Object({ clauseId: tNanoid }),
    },
  )
  // ── Versions ───────────────────────────────────
  .get(
    "/:clauseId/versions/:versionId",
    async (ctx) =>
      await getClauseVersionHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        versionId: ctx.params.versionId,
        scopedDb: ctx.scopedDb,
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
    async (ctx) =>
      await listVariantsHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        scopedDb: ctx.scopedDb,
      }),
    { params: t.Object({ clauseId: tNanoid }) },
  )
  .put(
    "/:clauseId/variants",
    async (ctx) =>
      await createVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["create"] },
      params: t.Object({ clauseId: tNanoid }),
      body: createVariantBodySchema,
    },
  )
  .post(
    "/:clauseId/variants/:variantId",
    async (ctx) =>
      await updateVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        variantId: ctx.params.variantId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
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
    async (ctx) =>
      await deleteVariantHandler({
        organizationId: ctx.session.activeOrganizationId,
        clauseId: ctx.params.clauseId,
        variantId: ctx.params.variantId,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { clause: ["delete"] },
      params: t.Object({
        clauseId: tNanoid,
        variantId: tNanoid,
      }),
    },
  );
