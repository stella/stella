import { ne } from "drizzle-orm";

import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";
import type {
  VisibleWorkspaceStatus,
  WorkspaceStatus,
} from "@stll/api-contract/workspace-status";

import { workspaces } from "@/api/db/schema";

type HiddenWorkspaceStatus = Exclude<WorkspaceStatus, VisibleWorkspaceStatus>;

// Readable means "not deleting", written as `<> 'deleting'` so the partial
// non-deleting indexes serve it. A second hidden status makes this `never`,
// so the query cannot silently keep showing it.
const HIDDEN_WORKSPACE_STATUS: [HiddenWorkspaceStatus] extends [
  typeof WORKSPACE_STATUS.deleting,
]
  ? HiddenWorkspaceStatus
  : never = WORKSPACE_STATUS.deleting;

/** The SQL condition for a workspace that is still readable. */
export const visibleWorkspaceSql = () =>
  ne(workspaces.status, HIDDEN_WORKSPACE_STATUS);

/** The relational-query filter for a workspace that is still readable. */
export const VISIBLE_WORKSPACE_FILTER = {
  ne: HIDDEN_WORKSPACE_STATUS,
} as const;
