import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { templateRecipes } from "@/api/db/schema";
import { templateRecipeDefinitionSchema } from "@/api/handlers/template-recipes/definition";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

// ── Schemas ─────────────────────────────────────────

// `definition` is structurally validated with Valibot inside the handler
// (the recipe shape — nested parts/format/loop invariants — is beyond what
// the route contract can express).
export const createTemplateRecipeBodySchema = t.Object({
  name: tDefaultVarchar,
  description: t.Optional(t.String({ maxLength: 2000 })),
  definition: t.Unknown(),
});

type CreateBody = Static<typeof createTemplateRecipeBodySchema>;

// ── List ────────────────────────────────────────────

type ListProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

// Bounded list, no cursor: recipes are capped per organization at
// LIMITS.templateRecipesCount, so the full set always fits one page.
export const listTemplateRecipesHandler = async ({
  scopedDb,
  organizationId,
}: ListProps) => {
  const result = await scopedDb((tx) =>
    tx.query.templateRecipes.findMany({
      where: { organizationId: { eq: organizationId } },
      columns: {
        id: true,
        name: true,
        description: true,
        definition: true,
      },
      orderBy: { name: "asc" },
      limit: LIMITS.templateRecipesCount,
    }),
  );

  return { recipes: result };
};

// ── Create ──────────────────────────────────────────

type CreateProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: CreateBody;
  recordAuditEvent: AuditRecorder;
};

export const createTemplateRecipeHandler = async ({
  scopedDb,
  organizationId,
  userId,
  body,
  recordAuditEvent,
}: CreateProps) => {
  const parsed = v.safeParse(templateRecipeDefinitionSchema, body.definition);
  if (!parsed.success) {
    const issue = parsed.issues.at(0);
    const path = issue ? v.getDotPath(issue) : null;
    return status(400, {
      message: `Invalid recipe definition${path ? ` at ${path}` : ""}: ${
        issue?.message ?? "unknown issue"
      }`,
    });
  }

  // Advisory lock + count + insert in one transaction to
  // prevent TOCTOU on the recipe limit.
  return await scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
    );

    const existingCount = await tx.$count(
      templateRecipes,
      eq(templateRecipes.organizationId, organizationId),
    );

    if (existingCount >= LIMITS.templateRecipesCount) {
      return status(400, {
        message: "Recipe limit reached",
      });
    }

    const [inserted] = await tx
      .insert(templateRecipes)
      .values({
        id: createSafeId<"templateRecipe">(),
        organizationId,
        name: body.name,
        description: body.description ?? null,
        definition: parsed.output,
        createdBy: userId,
      })
      .returning({
        id: templateRecipes.id,
        name: templateRecipes.name,
        description: templateRecipes.description,
        definition: templateRecipes.definition,
        createdAt: templateRecipes.createdAt,
      });

    if (!inserted) {
      panic("Failed to create template recipe");
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: inserted.id,
      metadata: {
        kind: "template-recipe",
        name: inserted.name,
        fieldCount: parsed.output.fields.length,
        loopPath: parsed.output.loop?.path ?? null,
      },
    });

    return inserted;
  });
};

// ── Delete ──────────────────────────────────────────

type DeleteProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  recipeId: SafeId<"templateRecipe">;
  recordAuditEvent: AuditRecorder;
};

export const deleteTemplateRecipeHandler = async ({
  scopedDb,
  organizationId,
  recipeId,
  recordAuditEvent,
}: DeleteProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.templateRecipes.findFirst({
      where: { id: { eq: recipeId }, organizationId: { eq: organizationId } },
      columns: { id: true, name: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Recipe not found" });
  }

  await scopedDb(async (tx) => {
    await tx
      .delete(templateRecipes)
      .where(
        and(
          eq(templateRecipes.id, recipeId),
          eq(templateRecipes.organizationId, organizationId),
        ),
      );

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
      resourceId: recipeId,
      metadata: {
        kind: "template-recipe",
        name: existing.name,
      },
    });
  });

  return {};
};
