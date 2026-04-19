import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauseVariants } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  safeDb: SafeDb,
  clauseId: string,
  organizationId: SafeId<"organization">,
) => {
  const result = await safeDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  return result;
};

// ── List ────────────────────────────────────────────

type ListVariantsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const listVariantsHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
}: ListVariantsProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const result = yield* Result.await(
    safeDb((tx) =>
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
    ),
  );

  return Result.ok({ variants: result });
};

// ── Create ──────────────────────────────────────────

type CreateVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  body: CreateVariantBody;
};

export const createVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  body,
}: CreateVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existingCount = yield* Result.await(
    safeDb((tx) =>
      tx.$count(clauseVariants, eq(clauseVariants.clauseId, clauseId)),
    ),
  );

  if (existingCount >= LIMITS.clauseVariantsPerClause) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Variant limit reached for this clause",
      }),
    );
  }

  const [inserted] = yield* Result.await(
    safeDb((tx) =>
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
    ),
  );

  return Result.ok(inserted);
};

// ── Update ──────────────────────────────────────────

type UpdateVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
  body: UpdateVariantBody;
};

export const updateVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  variantId,
  body,
}: UpdateVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: variantId,
          clauseId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Variant not found" }),
    );
  }

  const updates = {
    ...pickDefined(body, ["label", "body", "sortOrder"]),
    updatedAt: new Date(),
  };

  const [updated] = yield* Result.await(
    safeDb((tx) =>
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
    ),
  );

  return Result.ok(updated);
};

// ── Delete ──────────────────────────────────────────

type DeleteVariantProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  variantId: string;
};

export const deleteVariantHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  variantId,
}: DeleteVariantProps) {
  const clauseResult = await verifyClauseOwnership(
    safeDb,
    clauseId,
    organizationId,
  );

  if (Result.isError(clauseResult)) {
    return yield* Result.err(clauseResult.error);
  }

  if (!clauseResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: variantId,
          clauseId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Variant not found" }),
    );
  }

  yield* Result.await(
    safeDb((tx) =>
      tx
        .delete(clauseVariants)
        .where(
          and(
            eq(clauseVariants.id, variantId),
            eq(clauseVariants.clauseId, clauseId),
          ),
        ),
    ),
  );

  return Result.ok(undefined);
};
