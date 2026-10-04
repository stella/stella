/**
 * Position sources: the documents a playbook position was taken or revised
 * from.
 *
 * A position stores only `{ workspaceId, entityId }` pairs for its sources.
 * Document names are looked up here, on the caller's own access-scoped
 * database connection and limited to the matters the caller can access. As a
 * result, a caller can add only a document they can open, and a read returns
 * only the sources the caller can open. A deleted document, or one in a
 * matter the caller cannot access, is left out of the result.
 */

import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import type {
  Position,
  PositionSource,
} from "@/api/lib/workflow/playbook-positions";

export const positionSourceKey = ({ workspaceId, entityId }: PositionSource) =>
  `${workspaceId}:${entityId}`;

/** Each distinct source in the positions, in order of first appearance. */
export const positionSources = (
  positions: readonly Position[],
): PositionSource[] => {
  const byKey = new Map<string, PositionSource>();
  for (const position of positions) {
    for (const source of arrayOrEmpty(position.sources)) {
      byKey.set(positionSourceKey(source), source);
    }
  }
  return [...byKey.values()];
};

export const positionSourceEntityIds = (
  sources: readonly PositionSource[],
): SafeId<"entity">[] => [
  ...new Set(sources.map(({ entityId }) => brandPersistedEntityId(entityId))),
];

export type ReadablePositionSource = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  name: string;
  workspaceName: string;
};

type ReadablePositionSourcesArgs = {
  safeDb: SafeDb;
  entityIds: readonly SafeId<"entity">[];
  /**
   * The matters the caller can access right now. Row-level security is not
   * enough on its own: it still returns a matter that is being deleted, and a
   * chat thread or a restricted token may allow fewer matters than the
   * user's membership does.
   */
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
};

/**
 * Returns the documents among `entityIds` that the caller can read, each with
 * the matter it actually belongs to. It runs one query for the whole list on
 * the caller's access-scoped connection. A save uses it to check that the
 * caller can read a source; a read uses it to pick the sources to show.
 */
export const readablePositionSources = async ({
  safeDb,
  entityIds,
  accessibleWorkspaceIds,
}: ReadablePositionSourcesArgs): Promise<
  Result<ReadablePositionSource[], SafeDbError>
> => {
  if (entityIds.length === 0 || accessibleWorkspaceIds.length === 0) {
    return Result.ok([]);
  }
  return await safeDb((tx) =>
    tx
      .select({
        entityId: entities.id,
        workspaceId: entities.workspaceId,
        name: entities.name,
        workspaceName: workspaces.name,
      })
      .from(entities)
      .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
      .where(
        and(
          inArray(entities.id, [...entityIds]),
          inArray(entities.workspaceId, [...accessibleWorkspaceIds]),
          eq(entities.kind, "document"),
        ),
      )
      .limit(entityIds.length),
  );
};

/**
 * Returns the positions with every source the reader cannot open removed.
 * The ids come from the rows the reader's own query returned, not from the
 * stored position. Use this wherever a source becomes something the reader
 * can act on. In chat, each source becomes a ref, and a ref adds the source's
 * matter to the thread's observed scope, so an unreadable source must never
 * get that far.
 */
export const withReadableSources = (
  positions: readonly Position[],
  readable: readonly ReadablePositionSource[],
) => {
  const readableByKey = new Map(
    readable.map((row) => [
      positionSourceKey(row),
      { workspaceId: row.workspaceId, entityId: row.entityId },
    ]),
  );
  return positions.map((position) => {
    const { sources: stored, ...rest } = position;
    const sources = arrayOrEmpty(stored).flatMap((source) => {
      const row = readableByKey.get(positionSourceKey(source));
      return row === undefined ? [] : [row];
    });
    return sources.length === 0 ? rest : { ...rest, sources };
  });
};
