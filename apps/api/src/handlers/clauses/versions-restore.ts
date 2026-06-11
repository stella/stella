import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { clauses, clauseVersions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import { updateSearchVector } from "./search-vector";

const restoreClauseVersionParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
  versionId: tSafeId("clauseVersion"),
});

const config = {
  permissions: { clause: ["update"] },
  params: restoreClauseVersionParamsSchema,
} satisfies HandlerConfig;

type RestorePlan = { type: "at-limit" } | { type: "ok"; newVersion: number };

/**
 * Pure restore decision: refuse when the clause is at the version cap,
 * otherwise the restored body lands as `currentVersion + 1`. Restoring
 * always writes a new version (it never reuses the source version's
 * number), so the head moves forward and history stays append-only.
 */
export const planClauseVersionRestore = (args: {
  currentVersion: number;
  versionCount: number;
}): RestorePlan => {
  if (args.versionCount >= LIMITS.clauseVersionsPerClause) {
    return { type: "at-limit" };
  }
  return { type: "ok", newVersion: args.currentVersion + 1 };
};

/**
 * Restore a stored clause version: copy that version's snapshot body
 * onto the clause head as a NEW version, never mutating history. The
 * snapshot body is resolved server-side from the ID after the ownership
 * check; the client never supplies the body. Audited as a clause update.
 */
const restoreClauseVersion = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const { clauseId, versionId } = params;

    const clause = yield* Result.await(
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
            currentVersion: true,
          },
        }),
      ),
    );

    if (!clause) {
      return Result.err(
        new HandlerError({ status: 404, message: "Clause not found" }),
      );
    }

    const version = yield* Result.await(
      safeDb((tx) =>
        tx.query.clauseVersions.findFirst({
          where: {
            id: { eq: versionId },
            clauseId: { eq: clauseId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, version: true, body: true },
        }),
      ),
    );

    if (!version) {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }

    const versionCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(clauseVersions, eq(clauseVersions.clauseId, clauseId)),
      ),
    );

    const plan = planClauseVersionRestore({
      currentVersion: clause.currentVersion,
      versionCount,
    });

    if (plan.type === "at-limit") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Version limit reached for this clause",
        }),
      );
    }

    const newVersion = plan.newVersion;
    const restoredBody = version.body;

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .update(clauses)
          .set({
            body: restoredBody,
            currentVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(clauses.id, clauseId),
              eq(clauses.organizationId, organizationId),
            ),
          )
          .returning({
            id: clauses.id,
            currentVersion: clauses.currentVersion,
            updatedAt: clauses.updatedAt,
          });

        await tx.insert(clauseVersions).values({
          id: createSafeId<"clauseVersion">(),
          organizationId,
          clauseId,
          version: newVersion,
          body: restoredBody,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
          resourceId: clauseId,
          changes: {
            currentVersion: {
              old: clause.currentVersion,
              new: newVersion,
            },
            restoredFromVersion: {
              old: null,
              new: version.version,
            },
          },
        });

        return row;
      }),
    );

    if (!updated) {
      panic("Failed to restore clause version");
    }

    // Best-effort re-index: the restored body changes searchable text.
    const searchVectorResult = await updateSearchVector(
      safeDb,
      clauseId,
      clause.title,
      clause.description,
      restoredBody,
    );
    if (Result.isError(searchVectorResult)) {
      captureError(searchVectorResult.error, { clauseId });
    }

    return Result.ok(updated);
  },
);

export default restoreClauseVersion;
