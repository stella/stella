import type { Editor } from "@tiptap/core";
import { Result } from "better-result";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";
import {
  getEntityName,
  getFirstFile,
} from "@/components/workspaces/entity-utils";
import { toSafeId } from "@/lib/safe-id";
import type { ConditionNode, WorkspaceEntity } from "@/lib/types";

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
      resource: resourceRef({
        type: RESOURCE_TYPE.WORKSPACE,
        id: toSafeId<"workspace">(workspace.id),
      }),
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

/**
 * Settles the promise a debounced mention search hands back to the picker.
 * `claim` returns false when a newer search has replaced this one; that
 * search owns the picker now, so this one settles nothing. A failed search
 * rejects, which lets the picker tell a failed search from one with no
 * matches.
 */
export const settleLatestMentionSearch = async <T>({
  search,
  claim,
  resolve,
  reject,
}: {
  search: () => Promise<T>;
  claim: () => boolean;
  resolve: (items: T) => void;
  reject: (error: unknown) => void;
}): Promise<void> => {
  const result = await Result.tryPromise({
    try: search,
    catch: (cause) => cause,
  });
  if (!claim()) {
    return;
  }
  if (Result.isError(result)) {
    reject(result.error);
    return;
  }
  resolve(result.value);
};

/**
 * The `claim` for {@link settleLatestMentionSearch} when the pending search
 * lives in a ref: the search whose `resolve` still sits in the slot owns it
 * and frees it; any other search has been replaced.
 */
export const claimPendingMentionSearch = <T>(
  slot: { current: { resolve: (items: T) => void } | null },
  resolve: (items: T) => void,
): boolean => {
  if (slot.current?.resolve !== resolve) {
    return false;
  }
  slot.current = null;
  return true;
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
    resource: resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: entity.entityId,
    }),
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
      attrs: toChatMentionNodeAttrs(mention),
    })
    .insertContent(" ")
    .run();
};
