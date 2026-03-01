import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

export const updateClauseBodySchema = t.Object({
  title: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tNanoid)),
  language: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
  body: t.Optional(clauseBodySchema),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  metadata: t.Optional(t.Nullable(t.Record(t.String(), t.Unknown()))),
});

type UpdateClauseBody = Static<typeof updateClauseBodySchema>;

type UpdateClauseProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
  body: UpdateClauseBody;
};

export const updateClauseHandler = async ({
  organizationId,
  clauseId,
  body,
}: UpdateClauseProps) => {
  const existing = await db.query.clauses.findFirst({
    where: { id: clauseId, organizationId },
    columns: { id: true, currentVersion: true },
  });

  if (!existing) {
    return status(404, { message: "Clause not found" });
  }

  if (body.categoryId) {
    const category = await db.query.clauseCategories.findFirst({
      where: {
        id: body.categoryId,
        organizationId,
      },
      columns: { id: true },
    });

    if (!category) {
      return status(404, {
        message: "Category not found",
      });
    }
  }

  const updates: Partial<{
    title: string;
    categoryId: string | null;
    language: string | null;
    body: ClauseBody;
    description: string | null;
    metadata: Record<string, unknown> | null;
    currentVersion: number;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  if (body.title !== undefined) {
    updates.title = body.title;
  }
  if (body.categoryId !== undefined) {
    updates.categoryId = body.categoryId;
  }
  if (body.language !== undefined) {
    updates.language = body.language;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.metadata !== undefined) {
    updates.metadata = body.metadata;
  }

  // If body changes, bump version and create snapshot
  let newVersion: number | null = null;
  if (body.body !== undefined) {
    const versionCount = await db.$count(
      clauseVersions,
      eq(clauseVersions.clauseId, clauseId),
    );

    if (versionCount >= LIMITS.clauseVersionsPerClause) {
      return status(400, {
        message: "Version limit reached for this clause",
      });
    }

    newVersion = existing.currentVersion + 1;
    updates.body = body.body;
    updates.currentVersion = newVersion;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(clauses)
      .set(updates)
      .where(
        and(
          eq(clauses.id, clauseId),
          eq(clauses.organizationId, organizationId),
        ),
      )
      .returning({
        id: clauses.id,
        title: clauses.title,
        categoryId: clauses.categoryId,
        currentVersion: clauses.currentVersion,
        updatedAt: clauses.updatedAt,
      });

    if (newVersion !== null && body.body !== undefined) {
      await tx.insert(clauseVersions).values({
        id: nanoid(),
        clauseId,
        version: newVersion,
        body: body.body,
      });
    }

    return row;
  });

  return updated;
};
