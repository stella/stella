import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { ViewFilterCondition, WorkspaceEntity } from "@/lib/types";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const CHAT_MENTION_ENTITY_RESULT_LIMIT = 50;
export const CHAT_MENTION_SEARCH_DEBOUNCE_MS = 150;

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

export const buildEntityMentionOption = ({
  entity,
  sourceWorkspaceId,
}: {
  entity: WorkspaceEntity;
  sourceWorkspaceId?: string | undefined;
}): ChatMentionOption => {
  const file = getFirstFile(entity);
  const option: ChatMentionOption = {
    id: entity.entityId,
    label: getEntityName(entity),
    category: "entity",
    kind: entity.kind,
    mimeType: file?.mimeType ?? null,
  };
  if (sourceWorkspaceId !== undefined) {
    option.sourceWorkspaceId = sourceWorkspaceId;
  }
  return option;
};
