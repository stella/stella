import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
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
  scopedDb: ScopedDb,
  clauseId: string,
  organizationId: SafeId<"organization">,
) => {
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  return clause;
};

// ── List ────────────────────────────────────────────

type ListVariantsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const listVariantsHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
}: ListVariantsProps) => {
  const clause = await verifyClauseOwnership(
    scopedDb,
    clauseId,
    organizationId,
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const result = await scopedDb((tx) =>
    tx.query.clauseVariants.findMany({
      where: {
        clauseId,
        organizationId: { eq: organizationId },
      },
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
    }),
  );

  return { variants: result };
};

// ── Create ──────────────────────────────────────────

type CreateVariantProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  body: CreateVariantBody;
};

export const createVariantHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
  body,
}: CreateVariantProps) => {
  const clause = await verifyClauseOwnership(
    scopedDb,
    clauseId,
    organizationId,
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existingCount = await scopedDb((tx) =>
    tx.$count(clauseVariants, eq(clauseVariants.clauseId, clauseId)),
  );

  if (existingCount >= LIMITS.clauseVariantsPerClause) {
    return status(400, {
      message: "Variant limit reached for this clause",
    });
  }

  const [inserted] = await scopedDb((tx) =>
    tx
      .insert(clauseVariants)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        clauseId,
        label: body.label,
        body: body.body,
      })
      .returning({
        id: clauseVariants.id,
        label: clauseVariants.label,
        sortOrder: clauseVariants.sortOrder,
        createdAt: clauseVariants.createdAt,
      }),
  );

  return inserted;
};

// ── Update ──────────────────────────────────────────

type UpdateVariantProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
  body: UpdateVariantBody;
};

export const updateVariantHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
  variantId,
  body,
}: UpdateVariantProps) => {
  const clause = await verifyClauseOwnership(
    scopedDb,
    clauseId,
    organizationId,
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existing = await scopedDb((tx) =>
    tx.query.clauseVariants.findFirst({
      where: {
        id: variantId,
        clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Variant not found" });
  }

  const updates = {
    ...pickDefined(body, ["label", "body", "sortOrder"]),
    updatedAt: new Date(),
  };

  const [updated] = await scopedDb((tx) =>
    tx
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
      }),
  );

  return updated;
};

// ── Delete ──────────────────────────────────────────

type DeleteVariantProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
};

export const deleteVariantHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
  variantId,
}: DeleteVariantProps) => {
  const clause = await verifyClauseOwnership(
    scopedDb,
    clauseId,
    organizationId,
  );

  if (!clause) {
    return status(404, { message: "Clause not found" });
  }

  const existing = await scopedDb((tx) =>
    tx.query.clauseVariants.findFirst({
      where: {
        id: variantId,
        clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Variant not found" });
  }

  await scopedDb((tx) =>
    tx
      .delete(clauseVariants)
      .where(
        and(
          eq(clauseVariants.id, variantId),
          eq(clauseVariants.clauseId, clauseId),
        ),
      ),
  );

  return undefined;
};
