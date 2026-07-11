import { panic } from "better-result";

import type { EntityKind } from "@/lib/types";

export const resolveSidebarWorkspaceId = ({
  chatWorkspaceId,
  workspaceId,
}: {
  chatWorkspaceId: string | undefined;
  workspaceId: string | undefined;
}): string | undefined => workspaceId ?? chatWorkspaceId;

export const resolveAutomaticExpandedMatterId = ({
  activeMatterIsVisible,
  activeWorkspaceId,
}: {
  activeMatterIsVisible: boolean;
  activeWorkspaceId: string | undefined;
}): string | null =>
  activeMatterIsVisible && activeWorkspaceId ? activeWorkspaceId : null;

type RecentWorkspace = {
  id: string;
  lastActivityAt: Date | string;
};

const activityTime = ({ lastActivityAt }: RecentWorkspace): number =>
  lastActivityAt instanceof Date
    ? lastActivityAt.getTime()
    : new Date(lastActivityAt).getTime();

export const selectRecentWorkspaces = <TWorkspace extends RecentWorkspace>({
  activeWorkspaceId,
  chatActivityByWorkspaceId,
  limit,
  pinnedIds,
  workspaces,
}: {
  activeWorkspaceId: string | undefined;
  chatActivityByWorkspaceId: ReadonlyMap<string, Date | string>;
  limit: number;
  pinnedIds: ReadonlySet<string>;
  workspaces: readonly TWorkspace[];
}): TWorkspace[] => {
  const recentActivityTime = (workspace: TWorkspace): number => {
    const chatActivity = chatActivityByWorkspaceId.get(workspace.id);
    if (chatActivity === undefined) {
      return activityTime(workspace);
    }

    const chatActivityTime =
      chatActivity instanceof Date
        ? chatActivity.getTime()
        : new Date(chatActivity).getTime();
    return Math.max(activityTime(workspace), chatActivityTime);
  };
  const sorted = workspaces
    .filter((workspace) => !pinnedIds.has(workspace.id))
    .toSorted(
      (left, right) => recentActivityTime(right) - recentActivityTime(left),
    );
  const activeWorkspace = sorted.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (!activeWorkspace) {
    return sorted.slice(0, limit);
  }

  return [
    activeWorkspace,
    ...sorted.filter((workspace) => workspace.id !== activeWorkspace.id),
  ].slice(0, limit);
};

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
