/**
 * Where the decision table's rows come from.
 *
 * The same four-entry contract a matter's table reads its rows through, minus
 * the two a grouped table needs: decisions are a corpus answered one numbered
 * page at a time, never partitioned into sections the table fetches one at a
 * time. What
 * the entries name is the public decision queries, so the results page and the
 * matter's case-law panel cannot drift into fetching rows a third way.
 */

import type { DecisionsPageOptionsInput } from "@/features/case-law/queries/decisions";
import {
  decisionOptions,
  decisionsPageOptions,
} from "@/features/case-law/queries/decisions";
import type { WorkspaceTableAdapter } from "@/lib/workspaces/table-adapter";

/** The arguments the decision table's own entry points take. */
export type DecisionTableAdapterKeys = {
  listPage: [input: DecisionsPageOptionsInput];
  detail: [decisionId: string];
};

export const decisionTableAdapter = {
  useListPage: decisionsPageOptions,
  detail: decisionOptions,
} as const satisfies WorkspaceTableAdapter<DecisionTableAdapterKeys>;
