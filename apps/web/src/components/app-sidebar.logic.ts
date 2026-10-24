import { panic } from "better-result";

import type { WebApiRoutes } from "@/lib/eden-client";
import type { EntityKind } from "@/lib/types";

export const resolveSidebarWorkspaceId = ({
  chatWorkspaceId,
  workspaceId,
}: {
  chatWorkspaceId: string | undefined;
  workspaceId: string | undefined;
}): string | undefined => workspaceId ?? chatWorkspaceId;

type MatterNavigationIdentity = {
  // Optional while API and web revisions overlap during a rolling deploy.
  // Remove once defaultViewId is part of the minimum supported API contract.
  defaultViewId?: string | null;
  id: string;
};

export type MatterNavigationTarget =
  | {
      params: { viewId: string; workspaceId: string };
      to: "/workspaces/$workspaceId/$viewId";
    }
  | {
      params: { workspaceId: string };
      to: "/workspaces/$workspaceId";
    };

export const resolveMatterNavigationTarget = ({
  defaultViewId,
  id,
}: MatterNavigationIdentity): MatterNavigationTarget => {
  if (defaultViewId === null || defaultViewId === undefined) {
    return {
      params: { workspaceId: id },
      to: "/workspaces/$workspaceId",
    };
  }

  return {
    params: { viewId: defaultViewId, workspaceId: id },
    to: "/workspaces/$workspaceId/$viewId",
  };
};

export const resolveAutomaticExpandedMatterId = ({
  activeMatterIsVisible,
  activeWorkspaceId,
}: {
  activeMatterIsVisible: boolean;
  activeWorkspaceId: string | undefined;
}): string | null =>
  activeMatterIsVisible && activeWorkspaceId ? activeWorkspaceId : null;

export const MATTER_BILLING_LINK_KINDS = {
  timesheets: "timesheets",
  invoices: "invoices",
} as const;

export type MatterBillingLink = {
  kind: (typeof MATTER_BILLING_LINK_KINDS)[keyof typeof MATTER_BILLING_LINK_KINDS];
};

export const getMatterBillingLinks = ({
  canReadInvoices,
  canReadTimeEntries,
  timeBillingPreviewEnabled,
}: {
  canReadInvoices: boolean;
  canReadTimeEntries: boolean;
  timeBillingPreviewEnabled: boolean;
}): MatterBillingLink[] => {
  if (!timeBillingPreviewEnabled) {
    return [];
  }

  const links: MatterBillingLink[] = [];
  if (canReadTimeEntries) {
    links.push({ kind: MATTER_BILLING_LINK_KINDS.timesheets });
  }
  if (canReadInvoices) {
    links.push({ kind: MATTER_BILLING_LINK_KINDS.invoices });
  }
  return links;
};

type RecentWorkspace = {
  id: string;
  lastActivityAt: Date;
};

const activityTime = ({ lastActivityAt }: RecentWorkspace): number =>
  lastActivityAt.getTime();

export const selectRecentWorkspaces = <TWorkspace extends RecentWorkspace>({
  activeWorkspaceId,
  chatActivityByWorkspaceId,
  limit,
  pinnedIds,
  workspaces,
}: {
  activeWorkspaceId: string | undefined;
  chatActivityByWorkspaceId: ReadonlyMap<string, string>;
  limit: number;
  pinnedIds: ReadonlySet<string>;
  workspaces: readonly TWorkspace[];
}): TWorkspace[] => {
  const recentActivityTime = (workspace: TWorkspace): number => {
    const chatActivity = chatActivityByWorkspaceId.get(workspace.id);
    if (chatActivity === undefined) {
      return activityTime(workspace);
    }

    return Math.max(activityTime(workspace), new Date(chatActivity).getTime());
  };
  const sorted = workspaces
    .filter((workspace) => !pinnedIds.has(workspace.id))
    .toSorted(
      (left, right) => recentActivityTime(right) - recentActivityTime(left),
    );
  if (limit <= 0) {
    return [];
  }
  // Order is driven ONLY by activity time. Selecting/opening a matter must not
  // reorder the list: forcing the active matter to the top made every click
  // yank the clicked row upward (a dizzy jump). The active matter keeps its
  // activity-ranked position and only moves when a real change updates its
  // lastActivityAt / chat activity.
  const shown = sorted.slice(0, limit);
  if (
    activeWorkspaceId === undefined ||
    shown.some((workspace) => workspace.id === activeWorkspaceId)
  ) {
    return shown;
  }
  const activeWorkspace = sorted.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (activeWorkspace === undefined) {
    return shown;
  }
  // The active matter ranks below the visible window: surface it as the last
  // row so it stays reachable and its tree can auto-expand, without disturbing
  // the order of the rows above it (no jump-to-top).
  return [...sorted.slice(0, Math.max(limit - 1, 0)), activeWorkspace];
};

/**
 * When the reader last chatted in each matter: the newest thread of each
 * matter group in the merged chat history. Feeds `selectRecentWorkspaces`
 * wherever recent matters are ranked, so every surface weighs chat the same.
 */
export const chatActivityByWorkspace = (groupedThreads: {
  workspaces: readonly {
    threads: readonly { updatedAt: string }[];
    workspaceId: string;
  }[];
}): Map<string, string> =>
  new Map(
    groupedThreads.workspaces.flatMap((workspace) => {
      const updatedAt = workspace.threads.at(0)?.updatedAt;
      return updatedAt ? [[workspace.workspaceId, updatedAt] as const] : [];
    }),
  );

/**
 * A picker's "recent" matters: the pinned ones first, in the reader's pinned
 * order, then the most recently active of the rest, ranked exactly as the
 * sidebar ranks them. At most `limit` in all.
 */
export const selectPinnedThenRecentWorkspaces = <
  TWorkspace extends RecentWorkspace,
>({
  chatActivityByWorkspaceId,
  limit,
  pinnedOrder,
  workspaces,
}: {
  chatActivityByWorkspaceId: ReadonlyMap<string, string>;
  limit: number;
  pinnedOrder: readonly string[];
  workspaces: readonly TWorkspace[];
}): TWorkspace[] => {
  const byId = new Map(
    workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const pinned = pinnedOrder
    .flatMap((id) => {
      const workspace = byId.get(id);
      return workspace === undefined ? [] : [workspace];
    })
    .slice(0, Math.max(limit, 0));
  return [
    ...pinned,
    ...selectRecentWorkspaces({
      activeWorkspaceId: undefined,
      chatActivityByWorkspaceId,
      limit: limit - pinned.length,
      pinnedIds: new Set(pinnedOrder),
      workspaces,
    }),
  ];
};

type MatterActivityPage = {
  items: readonly unknown[];
  nextCursor: string | null;
};

type MatterActivityIsKnownEmptyOptions = {
  isInvalidated: boolean;
  pages: readonly MatterActivityPage[] | undefined;
  status: "error" | "pending" | "success";
};

// Whether a matter's cached activity proves there is nothing to disclose.
// Emptiness must be proven, never assumed. A query that has not succeeded has
// nothing to prove it with; an invalidated one describes the matter as it was
// before the mutation that invalidated it, and the sidebar's disabled observer
// will not refetch it; and a last page that still carries a cursor may be
// followed by one holding activity. Only a fresh, drained, item-free result
// counts as known-empty.
export const matterActivityIsKnownEmpty = ({
  isInvalidated,
  pages,
  status,
}: MatterActivityIsKnownEmptyOptions): boolean => {
  if (status !== "success" || isInvalidated || pages === undefined) {
    return false;
  }

  const lastPage = pages.at(-1);
  if (lastPage === undefined || lastPage.nextCursor !== null) {
    return false;
  }

  return pages.every((page) => page.items.length === 0);
};

export type EntityActivityDestination =
  | { type: "document" }
  | { type: "all-view" }
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
      return { type: "all-view" };
    default:
      kind satisfies never;
      return panic("Unsupported entity kind");
  }
};

export type WorkspaceActivity =
  WebApiRoutes["workspaces"][":workspaceId"]["activity"]["get"]["response"][200]["items"][number];

export const matterActivityItemVisible = (item: WorkspaceActivity): boolean =>
  item.type === "thread" ||
  item.entityKind !== "task" ||
  item.listItemType === null ||
  item.listItemType === "task";
