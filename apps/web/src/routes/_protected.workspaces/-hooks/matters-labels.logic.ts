import type { PendingTextKey } from "@/components/pending-text";
import type { MattersColumnId, MattersSortKey } from "@/lib/workspaces/types";

/**
 * The message each matters sort is named by, read by the loaded toolbar and
 * table (`useSortLabels`) and by their loading faces (`PendingText`), so both
 * phases name a sort the same way.
 */
export const MATTERS_SORT_LABEL_KEYS = {
  name: "common.matter",
  reference: "common.reference",
  entityCount: "workspaces.overview.totalItems",
  lastActivityAt: "workspaces.lastActive",
  createdAt: "common.createdAt",
  clientName: "workspaces.parties.client",
} as const satisfies Record<MattersSortKey, PendingTextKey>;

/** The message each matters table column is named by, for both phases. */
export const MATTERS_COLUMN_LABEL_KEYS = {
  client: "workspaces.parties.client",
  team: "workspaces.team",
  reference: "common.reference",
  entityCount: "workspaces.overview.totalItems",
  lastActivityAt: "workspaces.lastActive",
  createdAt: "common.createdAt",
} as const satisfies Record<MattersColumnId, PendingTextKey>;
