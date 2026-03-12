import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";
import { nanoid } from "nanoid";

import type { ScopedDb } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

import { updateSearchVector } from "./search-vector";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

export const updateClauseBodySchema = t.Object({
  title: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tNanoid)),
  language: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
  body: t.Optional(clauseBodySchema),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  usageNotes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  metadata: t.Optional(t.Nullable(t.Record(t.String(), t.Unknown()))),
});

type UpdateClauseBody = Static<typeof updateClauseBodySchema>;

type UpdateClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
  body: UpdateClauseBody;
};

export const updateClauseHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
  body,
}: UpdateClauseProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: {
        id: true,
        title: true,
        description: true,
        body: true,
        currentVersion: true,
      },
    }),
  );

  if (!existing) {
    return status(404, { message: "Clause not found" });
  }

  const categoryId = body.categoryId;
  if (categoryId) {
    const category = await scopedDb((tx) =>
      tx.query.clauseCategories.findFirst({
        where: {
          id: categoryId,
          organizationId: { eq: organizationId },
        },
        columns: { id: true },
      }),
    );

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
    usageNotes: string | null;
    metadata: Record<string, unknown> | null;
    currentVersion: number;
    updatedAt: Date;
  }> = {
    ...pickDefined(body, [
      "title",
      "categoryId",
      "language",
      "description",
      "usageNotes",
      "metadata",
    ]),
    updatedAt: new Date(),
  };

  // If body changes, bump version and create snapshot
  let newVersion: number | null = null;
  if (body.body !== undefined) {
    const versionCount = await scopedDb((tx) =>
      tx.$count(clauseVersions, eq(clauseVersions.clauseId, clauseId)),
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

  const updated = await scopedDb(async (tx) => {
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
        organizationId,
        clauseId,
        version: newVersion,
        body: body.body,
      });
    }

    return row;
  });

  // Re-index search vector when searchable fields change
  const searchFieldsChanged =
    body.title !== undefined ||
    body.description !== undefined ||
    body.body !== undefined;

  // Best-effort: if the search vector update fails the clause
  // is still persisted; it will be unsearchable until the next
  // update re-indexes it.
  if (searchFieldsChanged) {
    try {
      await updateSearchVector(
        scopedDb,
        clauseId,
        body.title ?? existing.title,
        body.description !== undefined
          ? body.description
          : existing.description,
        body.body ?? existing.body,
      );
    } catch {
      // Intentionally swallowed; see comment above.
    }
  }

  return updated;
};
