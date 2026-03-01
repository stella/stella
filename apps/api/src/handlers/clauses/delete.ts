import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteClauseProps = {
  organizationId: SafeId<"organization">;
  clauseId: string;
};

export const deleteClauseHandler = async ({
  organizationId,
  clauseId,
}: DeleteClauseProps) => {
  const existing = await db.query.clauses.findFirst({
    where: { id: clauseId, organizationId },
    columns: { id: true },
  });

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
  await db
    .delete(clauses)
    .where(
      and(eq(clauses.id, clauseId), eq(clauses.organizationId, organizationId)),
    );

  return;
};
