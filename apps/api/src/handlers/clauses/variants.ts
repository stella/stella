import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { clauseVariants } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";
import { clauseBodySchema } from "./shared-schemas";

// ── Schemas ─────────────────────────────────────────

export const createVariantBodySchema = t.Object({
  label: tDefaultVarchar,
  body: clauseBodySchema,
});

export const updateVariantBodySchema = t.Object({
  label: t.Optional(tDefaultVarchar),
  body: t.Optional(clauseBodySchema),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

type CreateVariantBody = Static<typeof createVariantBodySchema>;
type UpdateVariantBody = Static<typeof updateVariantBodySchema>;

// ── Helpers ─────────────────────────────────────────

const verifyClauseOwnership = async (
  clauseId: string,
  organizationId: SafeId<"organization">,
) => {
  const clause = await db.query.clauses.findFirst({
    where: {
      id: clauseId,
      organizationId: { eq: organizationId },
    },
    columns: { id: true },
  });

  return clause;
};

// ── List ────────────────────────────────────────────

type ListVariantsProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const listVariantsHandler = async ({
  organizationId,
  clauseId,
}: ListVariantsProps) => {
  const clause = await verifyClauseOwnership(clauseId, organizationId);

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const result = await db.query.clauseVariants.findMany({
    where: { clauseId },
    columns: {
      id: true,
      label: true,
      body: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { sortOrder: "asc" },
    limit: LIMITS.clauseVariantsPerClause,
  });

  return { variants: result };
};

// ── Create ──────────────────────────────────────────

type CreateVariantProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
  body: CreateVariantBody;
};

export const createVariantHandler = async ({
  organizationId,
  clauseId,
  body,
}: CreateVariantProps) => {
  const clause = await verifyClauseOwnership(clauseId, organizationId);

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existingCount = await db.$count(
    clauseVariants,
    eq(clauseVariants.clauseId, clauseId),
  );

  if (existingCount >= LIMITS.clauseVariantsPerClause) {
    return status(400, {
      message: "Variant limit reached for this clause",
    });
  }

  const [inserted] = await db
    .insert(clauseVariants)
    .values({
      id: nanoid(),
      clauseId,
      label: body.label,
      body: body.body,
    })
    .returning({
      id: clauseVariants.id,
      label: clauseVariants.label,
      sortOrder: clauseVariants.sortOrder,
      createdAt: clauseVariants.createdAt,
    });

  return inserted;
};

// ── Update ──────────────────────────────────────────

type UpdateVariantProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
  body: UpdateVariantBody;
};

export const updateVariantHandler = async ({
  organizationId,
  clauseId,
  variantId,
  body,
}: UpdateVariantProps) => {
  const clause = await verifyClauseOwnership(clauseId, organizationId);

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existing = await db.query.clauseVariants.findFirst({
    where: { id: variantId, clauseId },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Variant not found" });
  }

  const updates = {
    ...pickDefined(body, ["label", "body", "sortOrder"]),
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(clauseVariants)
    .set(updates)
    .where(
      and(
        eq(clauseVariants.id, variantId),
        eq(clauseVariants.clauseId, clauseId),
      ),
    )
    .returning({
      id: clauseVariants.id,
      label: clauseVariants.label,
      sortOrder: clauseVariants.sortOrder,
      updatedAt: clauseVariants.updatedAt,
    });

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteVariantProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
};

export const deleteVariantHandler = async ({
  organizationId,
  clauseId,
  variantId,
}: DeleteVariantProps) => {
  const clause = await verifyClauseOwnership(clauseId, organizationId);

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existing = await db.query.clauseVariants.findFirst({
    where: { id: variantId, clauseId },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Variant not found" });
  }

  await db
    .delete(clauseVariants)
    .where(
      and(
        eq(clauseVariants.id, variantId),
        eq(clauseVariants.clauseId, clauseId),
      ),
    );

  return;
};
