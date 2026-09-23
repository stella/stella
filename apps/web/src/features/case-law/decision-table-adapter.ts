/**
 * Where the decision table's rows come from.
 *
 * The same four-entry contract a matter's table reads its rows through, minus
 * the two a grouped table needs: decisions are a corpus answered by a cursor
 * chain, never partitioned into sections the table fetches one at a time. What
 * the entries name is the public decision queries, so the results page and the
 * matter's case-law panel cannot drift into fetching rows a third way.
 */

import type { PublicLawPageSize } from "@/components/public-law-table/public-law-pagination.logic";
import type { DecisionListFilters } from "@/features/case-law/queries/decisions";
import {
  decisionOptions,
  decisionsInfiniteOptions,
} from "@/features/case-law/queries/decisions";
import type { WorkspaceTableAdapter } from "@/lib/workspaces/table-adapter";

/** The arguments the decision table's own entry points take. */
export type DecisionTableAdapterKeys = {
  listPage: [filters: DecisionListFilters, pageSize: PublicLawPageSize];
  detail: [decisionId: string];
};

export const decisionTableAdapter = {
  useListPage: decisionsInfiniteOptions,
  detail: decisionOptions,
} as const satisfies WorkspaceTableAdapter<DecisionTableAdapterKeys>;
