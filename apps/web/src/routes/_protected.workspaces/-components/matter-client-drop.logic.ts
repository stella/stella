import { panic } from "better-result";
import * as v from "valibot";

import { MATTER_CARD_DRAG_TYPE } from "@/lib/workspaces/drag-constants";
import type { Workspace, WorkspaceGroup } from "@/lib/workspaces/types";

const matterCardDragSchema = v.object({
  type: v.literal(MATTER_CARD_DRAG_TYPE),
  matterId: v.string(),
  matterName: v.string(),
  origin: v.variant("type", [
    v.object({ type: v.literal("personal") }),
    v.object({ type: v.literal("client"), clientId: v.string() }),
  ]),
});

export type MatterCardDragData = v.InferOutput<typeof matterCardDragSchema>;

type MatterCardDragSource = Pick<Workspace, "id" | "name"> & {
  client: Pick<NonNullable<Workspace["client"]>, "id"> | null;
};

export const toMatterCardDragData = (
  workspace: MatterCardDragSource,
): MatterCardDragData => ({
  type: MATTER_CARD_DRAG_TYPE,
  matterId: workspace.id,
  matterName: workspace.name,
  origin: workspace.client
    ? { type: "client", clientId: workspace.client.id }
    : { type: "personal" },
});

// Drag payloads are shared by every drop target on the page, so a target reads
// only the drags that parse as a matter card.
export const readMatterCardDragData = (
  data: Record<string | symbol, unknown>,
): MatterCardDragData | null => {
  const parsed = v.safeParse(matterCardDragSchema, data);
  return parsed.success ? parsed.output : null;
};

type MatterClientDropTarget = {
  matterId: string;
  matterName: string;
  clientId: string;
  clientName: string;
};

// `move` reassigns a client matter; `promote` attaches the first client to a
// personal matter, which shares it with the team and cannot be undone.
export type AcceptedMatterClientDrop =
  | ({ type: "move"; previousClientId: string } & MatterClientDropTarget)
  | ({ type: "promote" } & MatterClientDropTarget);

export type MatterClientDrop = AcceptedMatterClientDrop | { type: "rejected" };

const REJECTED_DROP = { type: "rejected" } as const satisfies MatterClientDrop;

type ResolveMatterClientDropArgs = {
  source: MatterCardDragData;
  group: WorkspaceGroup;
};

export const resolveMatterClientDrop = ({
  source,
  group,
}: ResolveMatterClientDropArgs): MatterClientDrop => {
  switch (group.type) {
    case "personal":
      // A matter's client cannot be cleared, so nothing moves back to personal.
      return REJECTED_DROP;
    case "client":
      break;
    default:
      group satisfies never;
      return panic(`Unhandled matter group: ${String(group)}`);
  }

  const target = {
    matterId: source.matterId,
    matterName: source.matterName,
    clientId: group.clientId,
    clientName: group.clientName,
  };
  switch (source.origin.type) {
    case "personal":
      return { type: "promote", ...target };
    case "client":
      return source.origin.clientId === group.clientId
        ? REJECTED_DROP
        : { type: "move", previousClientId: source.origin.clientId, ...target };
    default:
      source.origin satisfies never;
      return panic(`Unhandled matter origin: ${String(source.origin)}`);
  }
};
