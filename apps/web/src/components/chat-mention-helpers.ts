import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { ViewFilterCondition } from "@/lib/types";

type MentionWorkspace = {
  id: string;
  name: string;
};

type ViewSort = {
  desc: boolean;
  propertyId: string;
};

type ViewLayout = {
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
};

export const buildWorkspaceMentionOptions = ({
  firstViewIdsByWorkspaceId,
  workspaces,
}: {
  firstViewIdsByWorkspaceId: Record<string, string | null> | undefined;
  workspaces: MentionWorkspace[] | undefined;
}): ChatMentionOption[] => {
  if (!workspaces) {
    return [];
  }

  const items: ChatMentionOption[] = [];
  for (const workspace of workspaces) {
    const viewId = firstViewIdsByWorkspaceId?.[workspace.id];
    if (!viewId) {
      continue;
    }

    items.push({
      id: workspace.id,
      label: workspace.name,
      category: "workspace",
      kind: "workspace",
      mimeType: null,
      sourceViewId: viewId,
    });
  }

  return items;
};

export const getMentionViewScope = (layout: ViewLayout | null | undefined) => ({
  filters: layout?.filters ?? [],
  sorts: layout?.sorts ?? [],
});
