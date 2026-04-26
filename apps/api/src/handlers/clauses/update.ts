import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

import { updateSearchVector } from "./search-vector";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

const updateClauseBodySchema = t.Object({
  title: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("clauseCategory"))),
  language: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
  body: t.Optional(clauseBodySchema),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  usageNotes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  metadata: t.Optional(t.Nullable(t.Record(t.String(), t.Unknown()))),
});

const updateClauseParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

type UpdateClauseBody = Static<typeof updateClauseBodySchema>;

type UpdateClauseProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  body: UpdateClauseBody;
};

const updateClauseHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  body,
}: UpdateClauseProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.clauses.findFirst({
        where: {
          id: { eq: clauseId },
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
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const categoryId = body.categoryId;
  if (categoryId) {
    const category = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseCategories.findFirst({
          where: {
            id: { eq: categoryId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!category) {
      return Result.err(
        new HandlerError({ status: 404, message: "Category not found" }),
      );
    }
  }

  const updates: Partial<{
    title: string;
    categoryId: SafeId<"clauseCategory"> | null;
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
    const versionCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(clauseVersions, eq(clauseVersions.clauseId, clauseId)),
      ),
    );

    if (versionCount >= LIMITS.clauseVersionsPerClause) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Version limit reached for this clause",
        }),
      );
    }

    newVersion = existing.currentVersion + 1;
    updates.body = body.body;
    updates.currentVersion = newVersion;
  }

  const updated = yield* Result.await(
    safeDb(async (tx) => {
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
          id: createSafeId<"clauseVersion">(),
          organizationId,
          clauseId,
          version: newVersion,
          body: body.body,
        });
      }

      return row;
    }),
  );

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
        safeDb,
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

  return Result.ok(updated);
};

const config = {
  permissions: { clause: ["update"] },
  params: updateClauseParamsSchema,
  body: updateClauseBodySchema,
} satisfies HandlerConfig;

const updateClause = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body }) {
    return yield* updateClauseHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      body,
    });
  },
);

export default updateClause;
