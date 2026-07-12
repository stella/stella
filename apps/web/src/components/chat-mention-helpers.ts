import type { Editor } from "@tiptap/core";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { ConditionNode, WorkspaceEntity } from "@/lib/types";
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
  filters: ConditionNode[];
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
    if (firstViewIdsByWorkspaceId !== undefined && !viewId) {
      continue;
    }

    items.push({
      id: workspace.id,
      label: workspace.name,
      category: "workspace",
      kind: "workspace",
      mimeType: null,
      ...(viewId && { sourceViewId: viewId }),
    });
  }

  return items;
};

export const getMentionViewScope = (layout: ViewLayout | null | undefined) => {
  if (!layout) {
    return { filters: [], sorts: [] };
  }
  return { filters: layout.filters, sorts: layout.sorts };
};

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

/**
 * Inserts a mention chip at the current cursor, followed by a trailing
 * space. The single insertion path for every mention source (the "@"
 * suggestion popover via `useChatEditor`'s `insertMention`, and the
 * composer (+) menu's Context submenu) so chips stay byte-identical
 * regardless of how they were picked.
 */
export const insertChatMention = (
  editor: Editor,
  mention: ChatMentionOption,
): void => {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "mention",
      attrs: {
        id: mention.id,
        label: mention.label,
        category: mention.category,
        kind: mention.kind,
        mimeType: mention.mimeType,
        sourceWorkspaceId: mention.sourceWorkspaceId,
      },
    })
    .insertContent(" ")
    .run();
};
