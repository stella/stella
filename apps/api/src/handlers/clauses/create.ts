import { eq } from "drizzle-orm";
import { status, t } from "elysia";
import { nanoid } from "nanoid";

import { db } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { updateSearchVector } from "./search-vector";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

export const createClauseBodySchema = t.Object({
  title: tDefaultVarchar,
  categoryId: t.Optional(tNanoid),
  language: t.Optional(t.String({ maxLength: 10 })),
  body: clauseBodySchema,
  description: t.Optional(t.String({ maxLength: 2000 })),
  usageNotes: t.Optional(t.String({ maxLength: 2000 })),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
});

type CreateClauseProps = {
  organizationId: SafeId<"organization">;
  userId: string;
  body: {
    title: string;
    categoryId?: string;
    language?: string;
    body: ClauseBody;
    description?: string;
    usageNotes?: string;
    metadata?: Record<string, unknown>;
  };
};

export const createClauseHandler = async ({
  organizationId,
  userId,
  body,
}: CreateClauseProps) => {
  const existingCount = await db.$count(
    clauses,
    eq(clauses.organizationId, organizationId),
  );

  if (existingCount >= LIMITS.clausesPerOrganization) {
    return status(400, {
      message: "Clause limit reached",
    });
  }

  if (body.categoryId) {
    const category = await db.query.clauseCategories.findFirst({
      where: {
        id: body.categoryId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    });

    if (!category) {
      return status(404, {
        message: "Category not found",
      });
    }
  }

  const clauseId = nanoid();
  const versionId = nanoid();

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(clauses)
      .values({
        id: clauseId,
        organizationId,
        categoryId: body.categoryId ?? null,
        title: body.title,
        description: body.description ?? null,
        usageNotes: body.usageNotes ?? null,
        language: body.language ?? null,
        body: body.body,
        metadata: body.metadata ?? null,
        currentVersion: 1,
        createdBy: userId,
      })
      .returning({
        id: clauses.id,
        title: clauses.title,
        categoryId: clauses.categoryId,
        currentVersion: clauses.currentVersion,
        createdAt: clauses.createdAt,
      });

    await tx.insert(clauseVersions).values({
      id: versionId,
      clauseId,
      version: 1,
      body: body.body,
    });

    return row;
  });

  // Best-effort: if the search vector update fails the clause
  // is still persisted; it will be unsearchable until the next
  // update re-indexes it.
  try {
    await updateSearchVector(clauseId, body.title, body.description, body.body);
  } catch {
    // Intentionally swallowed; see comment above.
  }

  return inserted;
};
