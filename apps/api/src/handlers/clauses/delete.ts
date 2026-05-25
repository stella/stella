import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { clauses } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteClauseParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

type DeleteClauseProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  recordAuditEvent: AuditRecorder;
};

const deleteClauseHandler = async function* ({
  safeDb,
  organizationId,
  clauseId,
  recordAuditEvent,
}: DeleteClauseProps) {
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
          categoryId: true,
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

  // FK constraints handle templateClauses nullification:
  //  - templateClauses.clauseId        → onDelete: "set null"
  //  - templateClauses.clauseVariantId → onDelete: "set null"
  //    (via cascade on clause_variants)
  //  - templateClauses.clauseVersionId → onDelete: "set null"
  //    (via cascade on clause_versions)
  // Cascade deletes variants + versions via FK
  yield* Result.await(
    safeDb(async (tx) => {
      await tx
        .delete(clauses)
        .where(
          and(
            eq(clauses.id, clauseId),
            eq(clauses.organizationId, organizationId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CLAUSE,
        resourceId: clauseId,
        changes: {
          deleted: {
            old: {
              title: existing.title,
              categoryId: existing.categoryId,
              currentVersion: existing.currentVersion,
            },
            new: null,
          },
        },
      });
    }),
  );

  return Result.ok(undefined);
};

const config = {
  permissions: { clause: ["delete"] },
  params: deleteClauseParamsSchema,
} satisfies HandlerConfig;

const deleteClause = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    return yield* deleteClauseHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      recordAuditEvent,
    });
  },
);

export default deleteClause;
