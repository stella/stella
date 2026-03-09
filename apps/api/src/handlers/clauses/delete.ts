import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const deleteClauseHandler = async ({
  scopedDb,
  organizationId,
  clauseId,
}: DeleteClauseProps) => {
  const existing = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  if (!existing) {
    return status(404, { message: "Clause not found" });
  }

  // FK constraints handle templateClauses nullification:
  //  - templateClauses.clauseId        → onDelete: "set null"
  //  - templateClauses.clauseVariantId → onDelete: "set null"
  //    (via cascade on clause_variants)
  //  - templateClauses.clauseVersionId → onDelete: "set null"
  //    (via cascade on clause_versions)
  // Cascade deletes variants + versions via FK
  await scopedDb((tx) =>
    tx
      .delete(clauses)
      .where(
        and(
          eq(clauses.id, clauseId),
          eq(clauses.organizationId, organizationId),
        ),
      ),
  );

  return;
};
