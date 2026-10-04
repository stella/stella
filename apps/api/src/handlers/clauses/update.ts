import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { CLAUSE_VERSION_LIMIT_ERROR_CODE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { clauses, clauseVersions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder, FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  clauseBodySchema,
  clauseExpectedBodySchema,
} from "@/api/lib/clauses/body-schema";
import { validateClauseBodyDirectives } from "@/api/lib/clauses/clause-directives";
import { normalizeClauseBody } from "@/api/lib/clauses/types";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { pickDefined } from "@/api/lib/pick-defined";

import type { ClauseMetadata } from "./metadata";
import { normalizeClauseMetadata } from "./metadata";
import { updateSearchVector } from "./search-vector";

const updateClauseBodySchema = t.Object({
  title: t.Optional(tDefaultVarchar),
  categoryId: t.Optional(t.Nullable(tSafeId("clauseCategory"))),
  language: t.Optional(t.Nullable(t.String({ maxLength: 10 }))),
  body: t.Optional(clauseBodySchema),
  expectedBody: t.Optional(clauseExpectedBodySchema),
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
 * `snapshotVersion: true` snapshots unless the requested body is structurally identical
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

export const updateClauseHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  body,
  recordAuditEvent,
}: UpdateClauseProps) {
  if (body.body !== undefined && body.snapshotVersion === true) {
    yield* validateClauseBodyDirectives(body.body);
  }

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

  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const [locked] = await tx
        .select()
        .from(clauses)
        .where(
          and(
            eq(clauses.id, clauseId),
            eq(clauses.organizationId, organizationId),
          ),
        )
        .for("update");
      if (!locked) {
        return { ok: false as const, reason: "missing" as const };
      }
      if (
        body.expectedBody !== undefined &&
        !deepEquals(
          normalizeClauseBody(locked.body),
          normalizeClauseBody(body.expectedBody),
        ) &&
        (body.body === undefined ||
          !deepEquals(
            normalizeClauseBody(locked.body),
            normalizeClauseBody(body.body),
          ))
      ) {
        return { ok: false as const, reason: "conflict" as const };
      }
      // The head working copy is always updated when a body is present
      // (autosave). A version snapshot is computed under a row lock so
      // concurrent snapshot requests serialize and can never compute the same
      // next version → no duplicate clause_versions.
      let newVersion: number | null = null;
      if (body.body !== undefined) {
        updates.body = body.body;
      }
      if (body.snapshotVersion === true && body.body !== undefined) {
        // Snapshot decisions use history read under the head lock; autosaves
        // move the working copy independently of the last saved version.
        const [latest] = await tx
          .select({ body: clauseVersions.body })
          .from(clauseVersions)
          .where(eq(clauseVersions.clauseId, clauseId))
          .orderBy(desc(clauseVersions.version))
          .limit(1);
        const shouldSnapshot = planClauseVersionSnapshot({
          snapshotVersion: body.snapshotVersion,
          hasBody: true,
          bodyEqualsLatestSnapshot:
            latest !== undefined &&
            deepEquals(
              normalizeClauseBody(latest.body),
              normalizeClauseBody(body.body),
            ),
        });
        if (shouldSnapshot) {
          const versionCount = await tx.$count(
            clauseVersions,
            eq(clauseVersions.clauseId, clauseId),
          );
          if (versionCount >= LIMITS.clauseVersionsPerClause) {
            return { ok: false as const, reason: "limit" as const };
          }
          newVersion = locked.currentVersion + 1;
          updates.currentVersion = newVersion;
        }
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
      addFieldDiff(changes, "title", locked.title, updates.title);
      addFieldDiff(
        changes,
        "categoryId",
        locked.categoryId,
        updates.categoryId,
      );
      addFieldDiff(changes, "language", locked.language, updates.language);
      addFieldDiff(changes, "body", locked.body, updates.body);
      addFieldDiff(
        changes,
        "description",
        locked.description,
        updates.description,
      );
      addFieldDiff(
        changes,
        "usageNotes",
        locked.usageNotes,
        updates.usageNotes,
      );
      addFieldDiff(changes, "metadata", locked.metadata, updates.metadata);
      addFieldDiff(
        changes,
        "currentVersion",
        locked.currentVersion,
        updates.currentVersion,
      );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
        resourceId: clauseId,
        changes,
      });

      return { ok: true as const, row };
    }),
  );

  if (!updated.ok) {
    switch (updated.reason) {
      case "conflict":
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "Clause body changed. Reload the clause before saving again.",
          }),
        );
      case "missing":
        return Result.err(
          new HandlerError({ status: 404, message: "Clause not found" }),
        );
      case "limit":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Version limit reached for this clause",
            code: CLAUSE_VERSION_LIMIT_ERROR_CODE,
            retryable: false,
          }),
        );
      default: {
        updated satisfies never;
        panic("Unhandled clause update outcome");
      }
    }
  }

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

  if (!updated.row) {
    panic("Failed to update clause");
  }

  return Result.ok(updated.row);
};

const addFieldDiff = (
  changes: FieldDiffs,
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void => {
  if (newValue !== undefined && oldValue !== newValue) {
    changes[key] = { old: oldValue ?? null, new: newValue };
  }
};

const config = {
  description:
    "Change a clause's title, category, language, body, description, usage " +
    "notes, or metadata; only the fields you pass are written. By default a " +
    "new body is saved as the working copy without touching history. Pass " +
    "snapshotVersion true to also append a version snapshot and move the " +
    "current version forward: that is skipped when the body is identical to " +
    "the latest snapshot, and refused when the clause is at its version " +
    "limit. Pass expectedBody from your last read to require the working " +
    "copy still matches; a changed body returns a conflict without writing.",
  permissions: { clause: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "save_clause" },
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
