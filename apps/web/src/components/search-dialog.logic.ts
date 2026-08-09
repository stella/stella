import {
  resourceRef,
  RESOURCE_TYPE,
  toResourceName,
  toSafeId,
} from "@stll/api-contract";
import type { GlobalSearchHit } from "@stll/api/types";

import type { RecentFile } from "@/lib/search-recents";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;
type EntityGlobalSearchHit = Extract<GlobalSearchHit, { entityId: string }>;

export type EntityNavigationRoute =
  | {
      to: "/workspaces/$workspaceId/$viewId/document";
      params: { workspaceId: string; viewId: "all" };
      search: { entity: string; field: string };
    }
  | {
      to: "/workspaces/$workspaceId/$viewId";
      params: { workspaceId: string; viewId: "all" };
    };

const getEntityDocumentRoute = ({
  entityId,
  fileFieldId,
  workspaceId,
}: Pick<
  EntityGlobalSearchHit,
  "entityId" | "fileFieldId" | "workspaceId"
>): EntityNavigationRoute => {
  if (fileFieldId === null) {
    return {
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId, viewId: "all" },
    };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId/document",
    params: { workspaceId, viewId: "all" },
    search: { entity: entityId, field: fileFieldId },
  };
};

type ResolveEntityDocumentRouteOptions = {
  hit: Pick<EntityGlobalSearchHit, "entityId" | "fileFieldId" | "workspaceId">;
  resolveCurrentFileFieldId: () => Promise<string | null>;
};

export const resolveEntityDocumentRoute = async ({
  hit,
  resolveCurrentFileFieldId,
}: ResolveEntityDocumentRouteOptions) => {
  const fileFieldId = await resolveCurrentFileFieldId();
  return {
    fileFieldId,
    route: getEntityDocumentRoute({ ...hit, fileFieldId }),
  };
};

export const getEntityWorkspaceRoute = ({
  workspaceId,
}: Pick<EntityGlobalSearchHit, "workspaceId">): EntityNavigationRoute => ({
  to: "/workspaces/$workspaceId/$viewId",
  params: { workspaceId, viewId: "all" },
});

export const getRecentFileRoute = ({
  entityId,
  fileFieldId,
  workspaceId,
}: Pick<RecentFile, "entityId" | "workspaceId"> & {
  fileFieldId: string | null;
}): EntityNavigationRoute => {
  if (fileFieldId === null) {
    return {
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId, viewId: "all" },
    };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId/document",
    params: { workspaceId, viewId: "all" },
    search: { entity: entityId, field: fileFieldId },
  };
};

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
) => {
  const resource = resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: toSafeId<"entity">(file.entityId),
  });

  return {
    entityId: file.entityId,
    fileFieldId: resolvedFileFieldId ?? file.fileFieldId ?? null,
    filePropertyId: file.filePropertyId ?? null,
    headline: null,
    id: `document:${file.entityId}`,
    lastEditedByImage: null,
    lastEditedByName: null,
    mimeType: file.mimeType ?? null,
    resource,
    resourceName: toResourceName(resource),
    title: file.title,
    type: "document",
    updatedAt: file.updatedAt ?? file.openedAt,
    workspaceId: file.workspaceId,
    workspaceName: file.workspaceName,
  } satisfies EntityGlobalSearchHit;
};

export const getRecentFilePreviewDateVisibility = (
  file: RecentFile,
): "hide" | "show" => (file.updatedAt ? "show" : "hide");

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
