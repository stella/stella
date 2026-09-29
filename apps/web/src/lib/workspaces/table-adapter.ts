/**
 * Where a workspace table's rows come from.
 *
 * The table stack reads rows through exactly these four entry points: one
 * window of a flat table, one window of a grouped section, the per-section
 * counts that let an empty section skip its row query, and one row for a
 * detail surface. Naming them is what stops a fifth ad-hoc query appearing
 * inside a cell, which is how a virtualised table acquires an N+1.
 *
 * Every entry is a query-options factory rather than a promise: the table
 * never fetches, so the transport, the cache keys and the retry policy stay
 * with the data layer. The shape is structural and its keys are the host's,
 * so a table over another row kind implements the same four entry points
 * against its own queries.
 */

import type {
  EntitiesWindowOptionsInput,
  GroupCountsOptionsInput,
  KanbanGroupOptionsInput,
} from "@/lib/workspaces/queries/entities";
import {
  entityOptions,
  groupCountsOptions,
  useEntitiesWindowOptions,
  useKanbanGroupOptions,
} from "@/lib/workspaces/queries/entities";

/**
 * A query-options factory. The return type names only what makes it query
 * options, so a promise (or anything else the table would have to await)
 * cannot stand in for one.
 */
type RowQuery<TArgs extends readonly unknown[]> = (...args: TArgs) => {
  queryKey: readonly unknown[];
};

/**
 * The arguments each entry point takes, per host. A host whose rows never
 * group omits the two section entries, the way a row host omits a behaviour
 * its kind does not have, rather than supplying a stub the table would have to
 * recognise as one.
 */
type WorkspaceTableAdapterKeys = {
  listPage: readonly unknown[];
  sectionPage?: readonly unknown[];
  sectionCounts?: readonly unknown[];
  detail: readonly unknown[];
};

type SectionEntries<TKeys extends WorkspaceTableAdapterKeys> =
  TKeys["sectionPage"] extends readonly unknown[]
    ? TKeys["sectionCounts"] extends readonly unknown[]
      ? {
          /** One window of rows for one section of a grouped table. */
          useSectionPage: RowQuery<TKeys["sectionPage"]>;
          /** Row counts per section, so an empty section never fetches rows. */
          sectionCounts: RowQuery<TKeys["sectionCounts"]>;
        }
      : never
    : // A host whose rows never group names no section entry at all, so
      // `keyof` over its adapter is exactly what it implements.
      Record<never, never>;

export type WorkspaceTableAdapter<TKeys extends WorkspaceTableAdapterKeys> = {
  /** One window of rows for a flat table. Deferred, so filters keep stale rows. */
  useListPage: RowQuery<TKeys["listPage"]>;
  /** One row, for a detail surface. */
  detail: RowQuery<TKeys["detail"]>;
} & SectionEntries<TKeys>;

/** The arguments the entity table's own entry points take. */
export type WorkspaceEntityAdapterKeys = {
  listPage: [key: EntitiesWindowOptionsInput];
  sectionPage: [key: KanbanGroupOptionsInput];
  sectionCounts: [key: GroupCountsOptionsInput];
  detail: [workspaceId: string, entityId: string];
};

export const workspaceTableAdapter = {
  useListPage: useEntitiesWindowOptions,
  useSectionPage: useKanbanGroupOptions,
  sectionCounts: groupCountsOptions,
  detail: entityOptions,
} as const satisfies WorkspaceTableAdapter<WorkspaceEntityAdapterKeys>;
