import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";
import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import type { SearchScope } from "@/components/search-scope";
import type {
  GlobalSearchHit,
  GlobalSearchResultType,
} from "@/lib/api-contract";
import { chatThreadRoute } from "@/lib/chat-thread-ref";
import type { ChatThreadRoute } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";
import type { RecentFile } from "@/lib/search-recents";
import { getFirstSearchHighlightText } from "@/lib/search.logic";

type CaseLawGlobalSearchHit = Extract<GlobalSearchHit, { type: "case-law" }>;
type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;
type EntityGlobalSearchHit = Extract<GlobalSearchHit, { entityId: string }>;

type CompanySearchQueryOptions = {
  open: boolean;
  mode: "browse" | "pick";
  query: string;
  debouncedQuery: string;
};

type LazySearchGroupOptions = {
  open: boolean;
  mode: CompanySearchQueryOptions["mode"];
  scope: SearchScope;
  query: string;
  expanded: boolean;
};

type EagerSearchTypesOptions = {
  mode: CompanySearchQueryOptions["mode"];
  scope: SearchScope;
  types: GlobalSearchResultType[];
};

export const resolveEagerSearchTypes = ({
  mode,
  scope,
  types,
}: EagerSearchTypesOptions) =>
  mode === "browse" && scope === "all"
    ? types.filter((type) => type !== "case-law")
    : types;

export const isLazySearchGroupActive = ({
  open,
  mode,
  scope,
  query,
  expanded,
}: LazySearchGroupOptions): boolean =>
  open &&
  mode === "browse" &&
  scope === "all" &&
  expanded &&
  query.trim().length > 0;

export const resolveRegistryResultsPane = ({
  scope,
  expanded,
  visible,
  registryVisible,
  caseLawEnabled,
}: Pick<LazySearchGroupOptions, "scope" | "expanded"> & {
  registryVisible: boolean;
  caseLawEnabled: boolean;
  visible: boolean;
}) => {
  const active = scope === "all" && expanded && visible;
  return {
    active,
    hideMatterChrome: registryVisible || active,
    caseLawEnabled: caseLawEnabled && !active,
  };
};

export const getCompanySearchQuery = ({
  open,
  mode,
  query,
  debouncedQuery,
}: CompanySearchQueryOptions): string | null => {
  const value = debouncedQuery.trim();
  if (!open || mode !== "browse" || query.trim() !== value) {
    return null;
  }
  return value.length <= 256 ? value : null;
};

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

/** What a caller must know to open an entity: search hits satisfy it, and so
 *  does any other resolution of an entity to its current file field. */
type EntityDocumentRouteInput = {
  entityId: string;
  fileFieldId: string | null;
  workspaceId: string;
};

/** Where an entity opens: its document view when a file field carries the
 *  document, otherwise the matter it lives in. */
export const getEntityDocumentRoute = ({
  entityId,
  fileFieldId,
  workspaceId,
}: EntityDocumentRouteInput): EntityNavigationRoute => {
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

/** Where an entity lives in its matter: a row of the file tree (with the
 *  folder to scope into when the matter has no tree), or, for tasks, which
 *  the tree does not list at any depth, just the matter. */
export type EntityLocation =
  | {
      type: "tree";
      workspaceId: string;
      entityId: string;
      fallbackFolderId: string | null;
    }
  | { type: "matter"; workspaceId: string };

/**
 * Cmd/Ctrl-activating a result opens the matter location containing the hit
 * instead of the hit itself. Only entity-backed hits have a containing
 * location; every other hit type returns null and keeps its normal open
 * behavior.
 */
export const getEntityLocation = (
  hit: GlobalSearchHit,
): EntityLocation | null => {
  if (
    hit.type === "contact" ||
    hit.type === "case-law" ||
    hit.type === "chat" ||
    hit.type === "matter"
  ) {
    return null;
  }

  return getEntityHitLocation(hit);
};

export const getEntityHitLocation = (
  hit: Pick<
    EntityGlobalSearchHit,
    "entityId" | "parentId" | "type" | "workspaceId"
  >,
): EntityLocation =>
  // A task's parent is another task, so neither has a tree row.
  hit.type === "task"
    ? { type: "matter", workspaceId: hit.workspaceId }
    : {
        type: "tree",
        workspaceId: hit.workspaceId,
        entityId: hit.entityId,
        fallbackFolderId: hit.parentId,
      };

/** A recent file's location: its tree row. Recent entries do not persist a
 *  containing folder, so a matter without a tree opens at its root. */
export const getRecentFileLocation = ({
  entityId,
  workspaceId,
}: Pick<RecentFile, "entityId" | "workspaceId">): EntityLocation => ({
  type: "tree",
  workspaceId,
  entityId,
  fallbackFolderId: null,
});

export const getRecentFileRoute = ({
  entityId,
  fileFieldId,
  workspaceId,
}: Pick<RecentFile, "entityId" | "workspaceId"> & {
  fileFieldId: string;
}): EntityNavigationRoute => ({
  to: "/workspaces/$workspaceId/$viewId/document",
  params: { workspaceId, viewId: "all" },
  search: { entity: entityId, field: fileFieldId },
});

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

export const getChatHitRoute = (hit: ChatGlobalSearchHit): ChatThreadRoute =>
  chatThreadRoute({ threadId: hit.threadId, workspaceId: hit.workspaceId });

type CaseLawHitSearch = { q?: string };

type CaseLawHitRoute =
  | {
      to: "/law/$country/cases/$court/$slug";
      params: { country: string; court: string; slug: string };
      search: CaseLawHitSearch;
    }
  | {
      to: "/law/$country/cases/$court/$language/$slug";
      params: {
        country: string;
        court: string;
        language: string;
        slug: string;
      };
      search: CaseLawHitSearch;
    };

/** The decision's canonical public route, opened on the hit's first match. */
export const getCaseLawHitRoute = (
  hit: CaseLawGlobalSearchHit,
): CaseLawHitRoute => {
  const { country, court, language, slug } = createCaseLawDecisionRouteParams({
    caseNumber: hit.caseNumber,
    country: hit.country,
    court: hit.court,
    decisionId: hit.decisionId,
    language: hit.language,
    languageAlternates: hit.languageAlternates,
    slug: hit.slug,
  });
  const search: CaseLawHitSearch = hit.headline
    ? { q: getFirstSearchHighlightText(hit.headline, "") }
    : {};

  return language === undefined
    ? {
        to: "/law/$country/cases/$court/$slug",
        params: { country, court, slug },
        search,
      }
    : {
        to: "/law/$country/cases/$court/$language/$slug",
        params: { country, court, language, slug },
        search,
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

type CanUseAskAIShortcutOptions = {
  canAskAI: boolean;
  mode: "browse" | "pick";
  query: string;
};

export const canUseAskAIShortcut = ({
  canAskAI,
  mode,
  query,
}: CanUseAskAIShortcutOptions): boolean =>
  mode === "browse" && canAskAI && query.trim().length > 0;

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
