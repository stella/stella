import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

import type { ClauseMetadata } from "./metadata";
import { normalizeClauseMetadata } from "./metadata";
import { updateSearchVector } from "./search-vector";
import { clauseBodySchema } from "./shared-schemas";
import type { ClauseBody } from "./types";

const updateClauseBodySchema = t.Object({
  title: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("clauseCategory"))),
  language: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
  body: t.Optional(clauseBodySchema),
  // When true, also append a `clause_versions` snapshot + bump
  // `currentVersion`. Autosave omits it (head-only working-copy save);
  // an explicit "Save as new version" / leave-with-changes sends `true`.
  snapshotVersion: t.Optional(t.Boolean()),
  description: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  usageNotes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
  metadata: t.Optional(t.Nullable(t.Record(t.String(), t.Unknown()))),
});

const updateClauseParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

type UpdateClauseBody = Static<typeof updateClauseBodySchema>;

/**
 * Pure decision for whether an update should append a `clause_versions`
 * snapshot. Autosave (`snapshotVersion` falsy) never snapshots; an explicit
 * `snapshotVersion: true` snapshots unless the requested body is byte-identical
 * to the latest stored snapshot (a no-op snapshot would just duplicate the last
 * version). The head working-copy update is independent of this decision.
 */
export const planClauseVersionSnapshot = (args: {
  snapshotVersion: boolean | undefined;
  hasBody: boolean;
  bodyEqualsLatestSnapshot: boolean;
}): boolean => {
  if (args.snapshotVersion !== true || !args.hasBody) {
    return false;
  }
  return !args.bodyEqualsLatestSnapshot;
};

type UpdateClauseProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  body: UpdateClauseBody;
  recordAuditEvent: AuditRecorder;
};

const updateClauseHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  body,
  recordAuditEvent,
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
          usageNotes: true,
          language: true,
          categoryId: true,
          metadata: true,
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
    metadata: ClauseMetadata | null;
    currentVersion: number;
    updatedAt: Date;
  }> = {
    ...pickDefined(body, [
      "title",
      "categoryId",
      "language",
      "description",
      "usageNotes",
    ]),
    ...(body.metadata === undefined
      ? {}
      : { metadata: normalizeClauseMetadata(body.metadata) ?? null }),
    updatedAt: new Date(),
  };

  // Autosave (no `snapshotVersion`) always updates the head working copy but
  // never appends to history. A version snapshot is written only on an explicit
  // "Save as new version" / leave-with-changes request. The version itself is
  // computed under a row lock in the write transaction below, not from this
  // (unlocked) read.
  //
  // Dedupe: compare the incoming body against the LATEST stored snapshot, not
  // against the head. The head moves on every autosave, so it is not a reliable
  // proxy; the snapshot body is what history actually contains. If they match,
  // an explicit snapshot would create a duplicate version, so skip it.
  let bodyEqualsLatestSnapshot = false;
  if (body.snapshotVersion === true && body.body !== undefined) {
    const latestVersion = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseVersions.findFirst({
          where: {
            clauseId: { eq: clauseId },
            organizationId: { eq: organizationId },
          },
          orderBy: { version: "desc" },
          columns: { body: true },
        }),
      ),
    );

    bodyEqualsLatestSnapshot =
      latestVersion !== undefined &&
      JSON.stringify(latestVersion.body) === JSON.stringify(body.body);
  }

  const shouldSnapshot = planClauseVersionSnapshot({
    snapshotVersion: body.snapshotVersion,
    hasBody: body.body !== undefined,
    bodyEqualsLatestSnapshot,
  });

  if (shouldSnapshot) {
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
  }

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      // The head working copy is always updated when a body is present
      // (autosave). A version snapshot is computed under a row lock so
      // concurrent snapshot requests serialize and can never compute the same
      // next version → no duplicate clause_versions.
      let newVersion: number | null = null;
      if (body.body !== undefined) {
        updates.body = body.body;
      }
      if (shouldSnapshot && body.body !== undefined) {
        const [locked] = await tx
          .select({ currentVersion: clauses.currentVersion })
          .from(clauses)
          .where(
            and(
              eq(clauses.id, clauseId),
              eq(clauses.organizationId, organizationId),
            ),
          )
          .for("update");
        newVersion = (locked?.currentVersion ?? existing.currentVersion) + 1;
        updates.currentVersion = newVersion;
      }

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

      const changes: FieldDiffs = {};
      for (const [key, newValue] of Object.entries(updates)) {
        if (key === "updatedAt") {
          continue;
        }
        const oldValue = (existing as Record<string, unknown>)[key];
        if (oldValue !== newValue) {
          changes[key] = { old: oldValue ?? null, new: newValue };
        }
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
        resourceId: clauseId,
        changes,
      });

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
    const searchVectorResult = await updateSearchVector(
      safeDb,
      clauseId,
      body.title ?? existing.title,
      body.description !== undefined ? body.description : existing.description,
      body.body ?? existing.body,
    );
    if (Result.isError(searchVectorResult)) {
      captureError(searchVectorResult.error, { clauseId });
    }
  }

  if (!updated) {
    panic("Failed to update clause");
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
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateClauseHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      body,
      recordAuditEvent,
    });
  },
);

export default updateClause;
