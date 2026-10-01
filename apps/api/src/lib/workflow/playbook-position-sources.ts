/**
 * Position sources: the documents a playbook position was taken or revised
 * from.
 *
 * A position stores `{ workspaceId, entityId }` pairs and nothing else about
 * its sources. Names are resolved here, through the caller's scoped
 * connection, so row security decides what each caller learns: a saver can
 * introduce only a document they can open, and a reader is answered only the
 * sources they can open. A document in a matter the caller cannot open and a
 * deleted document are both simply absent from the answer.
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

/** Every source a position list cites, deduplicated, in list order. */
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

/**
 * The documents among `entityIds` the caller can read, each with the matter it
 * truly belongs to. One query for the whole list, through the caller's scoped
 * connection: this is both the readability proof a save needs and the
 * per-reader resolution a read needs.
 */
export const readablePositionSources = async (
  safeDb: SafeDb,
  entityIds: readonly SafeId<"entity">[],
): Promise<Result<ReadablePositionSource[], SafeDbError>> => {
  if (entityIds.length === 0) {
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
          eq(entities.kind, "document"),
        ),
      )
      .limit(entityIds.length),
  );
};

/**
 * The positions with each source list narrowed to what the reader can open,
 * ids taken from the rows the reader's own connection returned. For a surface
 * that turns a source into a handle the reader can act on (a chat ref adds
 * the source's matter to the thread's observed scope), so an unreadable
 * source must not reach it at all.
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
