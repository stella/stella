import { panic } from "better-result";

import type { EntityKind } from "@/lib/types";

export const resolveSidebarWorkspaceId = ({
  chatWorkspaceId,
  workspaceId,
}: {
  chatWorkspaceId: string | undefined;
  workspaceId: string | undefined;
}): string | undefined => workspaceId ?? chatWorkspaceId;

export type EntityActivityDestination =
  | { type: "document" }
  | { type: "entity-route" }
  | { type: "folder" }
  | { type: "task" };

export const resolveEntityActivityDestination = (
  kind: EntityKind,
): EntityActivityDestination => {
  switch (kind) {
    case "task":
      return { type: "task" };
    case "folder":
      return { type: "folder" };
    case "document":
      return { type: "document" };
    case "message":
    case "link":
      return { type: "entity-route" };
    default:
      kind satisfies never;
      return panic("Unsupported entity kind");
  }
};
