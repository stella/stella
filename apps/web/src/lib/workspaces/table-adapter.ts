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
 * with the data layer.
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

export type WorkspaceTableAdapter = {
  /** One window of rows for a flat table. Deferred, so filters keep stale rows. */
  useListPage: typeof useEntitiesWindowOptions;
  /** One window of rows for one section of a grouped table. */
  useSectionPage: typeof useKanbanGroupOptions;
  /** Row counts per section, so an empty section never fetches rows. */
  sectionCounts: typeof groupCountsOptions;
  /** One row, for a detail surface. */
  detail: typeof entityOptions;
};

export const workspaceTableAdapter = {
  useListPage: useEntitiesWindowOptions,
  useSectionPage: useKanbanGroupOptions,
  sectionCounts: groupCountsOptions,
  detail: entityOptions,
} as const satisfies WorkspaceTableAdapter;

export type {
  EntitiesWindowOptionsInput,
  GroupCountsOptionsInput,
  KanbanGroupOptionsInput,
};
