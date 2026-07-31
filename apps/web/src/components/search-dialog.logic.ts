import type { GlobalSearchHit } from "@stll/api/types";

import type { RecentFile } from "@/lib/search-recents";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;
type DocumentGlobalSearchHit = Extract<GlobalSearchHit, { type: "document" }>;

type DialogCloseActionState =
  | { status: "idle" }
  | { status: "pending"; run: () => void };

export const createDialogCloseActionQueue = () => {
  let state: DialogCloseActionState = { status: "idle" };

  const cancel = () => {
    state = { status: "idle" };
  };

  const complete = (open: boolean) => {
    if (open) {
      cancel();
      return;
    }

    if (state.status === "idle") {
      return;
    }

    const { run } = state;
    state = { status: "idle" };
    run();
  };

  const schedule = (run: () => void) => {
    state = { status: "pending", run };
  };

  return { cancel, complete, schedule };
};

export const getRecentFilePreviewHit = (
  file: RecentFile,
  resolvedFileFieldId?: string | null,
) =>
  ({
    entityId: file.entityId,
    fileFieldId: resolvedFileFieldId ?? file.fileFieldId ?? null,
    headline: null,
    id: `document:${file.entityId}`,
    lastEditedByImage: null,
    lastEditedByName: null,
    mimeType: file.mimeType ?? null,
    title: file.title,
    type: "document",
    updatedAt: file.openedAt,
    workspaceId: file.workspaceId,
    workspaceName: file.workspaceName,
  }) satisfies DocumentGlobalSearchHit;

export type ChatHitRoute =
  | {
      to: "/chat/$threadId";
      params: { threadId: string };
    }
  | {
      to: "/chat/workspaces/$workspaceId/$threadId";
      params: { workspaceId: string; threadId: string };
    };

export const getChatHitRoute = (hit: ChatGlobalSearchHit): ChatHitRoute => {
  if (hit.workspaceId) {
    return {
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: hit.workspaceId, threadId: hit.threadId },
    };
  }

  return {
    to: "/chat/$threadId",
    params: { threadId: hit.threadId },
  };
};
