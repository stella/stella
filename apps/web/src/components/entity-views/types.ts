import type { TaskStatus } from "@stll/api-contract";
import type { EntityViewWorkRisk } from "@stll/api-contract/entity-views";

import type { InboxSignal } from "@/lib/inbox/queries";
import type { WorkspaceEntity } from "@/lib/types";

export type EntityViewScope =
  | { type: "matter"; matterId: string }
  | { type: "organization" };

/** The work a signal proposes, as the server's window typed it. */
const PROPOSAL_TYPES = ["task", "deadline"] as const;
type ProposalType = (typeof PROPOSAL_TYPES)[number];
export const isProposalType = (value: string): value is ProposalType =>
  PROPOSAL_TYPES.some((type) => type === value);

/**
 * A signal's values under the view's filters and sorts. The server derives
 * them once, in the same query that filters and orders the window, so the
 * client groups and labels proposals exactly as the server placed them.
 */
export type ProposalProjection = {
  kind: "task" | null;
  status: TaskStatus | null;
  type: ProposalType | null;
  dueDate: string | null;
};

export type EntityViewEntry =
  | {
      type: "entity";
      entity: WorkspaceEntity;
      workspaceId: string;
      workspaceName: string;
      workRisk: EntityViewWorkRisk;
    }
  | { type: "proposal"; signal: InboxSignal; projection: ProposalProjection };

export type EntityViewRow = {
  kind: "entity-view";
  entry: EntityViewEntry;
  children: [];
};
