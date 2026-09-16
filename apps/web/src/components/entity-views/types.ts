import type { InboxSignal } from "@/lib/inbox/queries";
import type { WorkspaceEntity } from "@/lib/types";

export type EntityViewScope =
  | { type: "matter"; matterId: string }
  | { type: "organization" };

export type EntityViewEntry =
  | {
      type: "entity";
      entity: WorkspaceEntity;
      workspaceId: string;
      workspaceName: string;
    }
  | { type: "proposal"; signal: InboxSignal };

export type EntityViewRow = {
  kind: "entity-view";
  entry: EntityViewEntry;
  children: [];
};
