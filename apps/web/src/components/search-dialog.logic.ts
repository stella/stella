import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";
import type { GlobalSearchHit } from "@stll/api/types";

import { toSafeId } from "@/lib/safe-id";
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

type EntityLocationRoute = {
  to: "/workspaces/$workspaceId/$viewId";
  params: { workspaceId: string; viewId: "all" };
  search?: { folder: string };
};

/**
 * Cmd/Ctrl-activating a result opens the matter location containing the hit
 * — scoped into its parent folder when it has one — instead of the hit
 * itself. Only entity-backed hits have a containing location; every other
 * hit type returns null and keeps its normal open behavior.
 */
export const getEntityLocationRoute = (
  hit: GlobalSearchHit,
): EntityLocationRoute | null => {
  if (
    hit.type === "contact" ||
    hit.type === "case-law" ||
    hit.type === "chat" ||
    hit.type === "matter"
  ) {
    return null;
  }

  return {
    to: "/workspaces/$workspaceId/$viewId",
    params: { workspaceId: hit.workspaceId, viewId: "all" },
    ...(hit.parentId === null ? {} : { search: { folder: hit.parentId } }),
  };
};

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
    // Recent-file entries do not persist the containing folder; the
    // location affordance only applies to live search hits.
    parentId: null,
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

/**
 * Chat message content travels as composer HTML; a raw search query must be
 * entity-escaped so `<`/`&` in the query survive as literal text.
 */
export const toAskAIMessageHtml = (query: string): string =>
  query
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const rememberSelectedFacetLabels = (
  current: Record<string, string>,
  selected: readonly string[],
  labelsByValue: ReadonlyMap<string, string>,
): Record<string, string> => {
  let next = current;
  for (const value of selected) {
    const label = labelsByValue.get(value);
    if (label === undefined || current[value] === label) {
      continue;
    }
    if (next === current) {
      next = { ...current };
    }
    next[value] = label;
  }
  return next;
};
