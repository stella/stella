import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { clauses } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

const deleteClauseParamsSchema = t.Object({
  clauseId: tNanoid,
});

type DeleteClauseProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: string;
};

const deleteClauseHandler = async ({
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

const config = {
  permissions: { clause: ["delete"] },
  params: deleteClauseParamsSchema,
} satisfies HandlerConfig;

const deleteClause = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await deleteClauseHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    }),
);

export default deleteClause;
