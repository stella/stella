import { Result } from "better-result";
import { and, asc, count, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { clauses, clauseVariants } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

type InsertClauseVariantsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  variants: Pick<
    typeof clauseVariants.$inferInsert,
    "clauseId" | "label" | "body" | "sortOrder"
  >[];
  recordAuditEvent: AuditRecorder;
};

/** All variant writers hold the parent lock through the count, insert and audit. */
export const insertClauseVariants = async ({
  tx,
  organizationId,
  variants,
  recordAuditEvent,
}: InsertClauseVariantsOptions) => {
  if (variants.length === 0) {
    return Result.ok([]);
  }

  const requestedCounts = new Map<SafeId<"clause">, number>();
  for (const { clauseId } of variants) {
    requestedCounts.set(clauseId, (requestedCounts.get(clauseId) ?? 0) + 1);
  }
  const clauseIds = [...requestedCounts.keys()];
  // A shared ordering prevents bulk imports and single creates from deadlocking.
  const ownedClauses = await tx
    .select({ id: clauses.id })
    .from(clauses)
    .where(
      and(
        eq(clauses.organizationId, organizationId),
        inArray(clauses.id, clauseIds),
      ),
    )
    .limit(clauseIds.length)
    .orderBy(asc(clauses.id))
    .for("update");

  if (ownedClauses.length !== clauseIds.length) {
    return Result.err(
      new HandlerError({ status: 404, message: "Clause not found" }),
    );
  }

  const existingCounts = await tx
    .select({ clauseId: clauseVariants.clauseId, count: count() })
    .from(clauseVariants)
    .where(
      and(
        eq(clauseVariants.organizationId, organizationId),
        inArray(clauseVariants.clauseId, clauseIds),
      ),
    )
    .groupBy(clauseVariants.clauseId);
  const counts = new Map(
    existingCounts.map((row) => [row.clauseId, row.count]),
  );
  for (const [clauseId, requestedCount] of requestedCounts) {
    if (
      (counts.get(clauseId) ?? 0) + requestedCount >
      LIMITS.clauseVariantsPerClause
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Variant limit reached for this clause",
        }),
      );
    }
  }

  const inserted = await tx
    .insert(clauseVariants)
    .values(
      variants.map((variant) => ({
        ...variant,
        id: createSafeId<"clauseVariant">(),
        organizationId,
      })),
    )
    .returning({
      id: clauseVariants.id,
      clauseId: clauseVariants.clauseId,
      label: clauseVariants.label,
      sortOrder: clauseVariants.sortOrder,
      createdAt: clauseVariants.createdAt,
    });

  await recordAuditEvent(
    tx,
    inserted.map((row) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT,
      resourceId: row.id,
      changes: {
        created: {
          old: null,
          new: { clauseId: row.clauseId, label: row.label },
        },
      },
    })),
  );

  return Result.ok(inserted);
};
