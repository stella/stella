import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createMockDatabase } from "@/api/db/sql-client";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";

export const documentSourceFixture = () => {
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const children = [
    { aggregate: "entityVersion", id: { id: versionId, workspaceId } },
    { aggregate: "field", id: { id: fieldId, workspaceId } },
  ] as const;
  const select = () =>
    createMockDatabase()
      .select({
        entityId: entities.id,
        workspaceId: entities.workspaceId,
        versionId: entityVersions.id,
        versionWorkspaceId: entityVersions.workspaceId,
        fieldId: fields.id,
        fieldWorkspaceId: fields.workspaceId,
      })
      .from(entities)
      .innerJoin(entityVersions, eq(entityVersions.entityId, entities.id))
      .innerJoin(fields, eq(fields.entityVersionId, entityVersions.id));
  return { workspaceId, entityId, versionId, fieldId, children, select };
};

/** A declared child order must be checked before issuing the joined lock. */
export const plantedDescendingDocumentChildren = async (tx: Transaction) => {
  const fixture = documentSourceFixture();
  return withAggregateRowQuery({
    tx,
    aggregate: "entity",
    id: { id: fixture.entityId, workspaceId: fixture.workspaceId },
    children: [fixture.children[1], fixture.children[0]],
    mode: "update",
    select: fixture.select,
  });
};
