import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { entities, entityLinks, flowRunSteps } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type FlowTaskTarget<TEntityId extends string, TLinkId extends string> =
  | { type: "entities"; entityIds: readonly TEntityId[] }
  | { type: "link"; linkId: TLinkId }
  | {
      type: "subtree";
      rootEntityIds: readonly TEntityId[];
      additionalEntityIds: readonly TEntityId[];
    };

export type FlowTaskMutationTarget = FlowTaskTarget<
  SafeId<"entity">,
  SafeId<"entityLink">
>;

const targetIdsCondition = (column: SQLWrapper, ids: readonly string[]) =>
  ids.length === 0
    ? sql`false`
    : sql`${column} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`;

/** Select persisted ownership over the complete mutation target, before any effect. */
export const flowTaskMutationTargetCondition = (
  workspaceId: SafeId<"workspace">,
  target: FlowTaskTarget<string, string>,
) => {
  switch (target.type) {
    case "entities":
      return targetIdsCondition(
        flowRunSteps.reviewTaskEntityId,
        target.entityIds,
      );
    case "link":
      return sql`${flowRunSteps.reviewTaskEntityId} IN (
        SELECT ${entityLinks.sourceEntityId} FROM ${entityLinks}
        WHERE ${and(eq(entityLinks.workspaceId, workspaceId), sql`${entityLinks.id} = ${target.linkId}`)}
        UNION
        SELECT ${entityLinks.targetEntityId} FROM ${entityLinks}
        WHERE ${and(eq(entityLinks.workspaceId, workspaceId), sql`${entityLinks.id} = ${target.linkId}`)}
      )`;
    case "subtree": {
      const roots = targetIdsCondition(entities.id, target.rootEntityIds);
      // UNION deduplicates identities, including a malformed parent cycle.
      return sql`${flowRunSteps.reviewTaskEntityId} IN (
        WITH RECURSIVE mutation_targets(id) AS (
          SELECT ${entities.id} FROM ${entities}
          WHERE ${and(eq(entities.workspaceId, workspaceId), roots)}
          UNION
          SELECT child.id FROM ${entities} child
          INNER JOIN mutation_targets parent ON child.parent_id = parent.id
          WHERE child.workspace_id = ${workspaceId}
        ) SELECT id FROM mutation_targets
        UNION
        SELECT ${entities.id} FROM ${entities}
        WHERE ${and(eq(entities.workspaceId, workspaceId), targetIdsCondition(entities.id, target.additionalEntityIds))}
      )`;
    }
    default:
      target satisfies never;
      return panic("Unknown linked task mutation target");
  }
};
