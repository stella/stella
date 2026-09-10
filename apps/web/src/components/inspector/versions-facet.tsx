/**
 * VersionsFacet — version history rendered inside the inspector
 * tab. Switching versions swaps the file shown in the SAME
 * inspector tab via `openFileForEntity`; we never navigate routes
 * or push a new tab. When the user is on the document route,
 * the route URL is also updated so the URL stays in sync with the
 * version actually being viewed (back/forward + reload preserve
 * the selection). Document comparison opens as a subview here so
 * version operations stay owned by one inspector facet.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Result } from "better-result";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { CompareVersionsPanel } from "@/components/inspector/compare-versions-panel";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { VersionsSidebar } from "@/components/pdf/versions-sidebar";
import type { Version } from "@/components/pdf/versions-sidebar";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { fileContentQueryKey } from "@/lib/files/file-metadata-query.logic";
import {
  entityVersionsOptions,
  fetchOlderVersions,
} from "@/lib/workspaces/queries/entity-versions";

type VersionsFacetProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
};

export const VersionsFacet = ({
  workspaceId,
  entityId,
  currentFieldId,
}: VersionsFacetProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const openFileForEntity = useInspectorTabsStore((s) => s.openFileForEntity);
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));

  // Accumulated list seeded from the query's newest page and extended
  // by each older page. Re-seed whenever a fresh `data` object arrives:
  // an upload / restore / delete invalidates `entityVersionsKeys.all`,
  // the query refetches the newest page, and TanStack hands back a new
  // `data` identity. Keying the re-seed on that identity (the chat
  // pattern, which keys on the `Chat` instance) keeps the cursor and
  // accumulator from going stale after such a refetch or an entity
  // switch. Refs mirror the state so the stable `loadOlder` callback
  // can read the latest committed values.
  // Initialize from `data` directly so a cache hit on first render seeds the
  // list (the re-seed below only fires when the data identity *changes*, which
  // never happens when useQuery returns cached data on mount).
  const [accumulated, setAccumulated] = useState<Version[]>(() =>
    data ? data.versions : [],
  );
  const [olderCursor, setOlderCursor] = useState<string | null>(
    data?.olderCursor ?? null,
  );
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [loadOlderError, setLoadOlderError] = useState(false);
  const [view, setView] = useState<"history" | "compare">("history");
  const [seededData, setSeededData] = useState(data);
  const olderCursorRef = useRef<string | null>(data?.olderCursor ?? null);
  const isLoadingOlderRef = useRef(false);
  // Render-current query-data identity for the stale-response guard in
  // `loadOlder`. A fresh `data` object means the page was rehydrated — an
  // entity switch OR a same-entity refetch (upload/restore/delete) — so an
  // in-flight older request must be discarded. Written during render (not a
  // passive effect) so a response resolving in the commit→effect window is
  // still caught.
  const seededDataRef = useRef(data);
  if (data !== undefined && seededData !== data) {
    setSeededData(data);
    setAccumulated(data.versions);
    setOlderCursor(data.olderCursor);
    setIsLoadingOlder(false);
    setLoadOlderError(false);
    /* eslint-disable react/refs -- deliberate render-time ref writes: they keep loadOlder's latest-value refs in sync with the re-seed so a response resolving in the commit→effect window is still caught by the stale-response guard; an effect would miss that window */
    olderCursorRef.current = data.olderCursor;
    isLoadingOlderRef.current = false;
    seededDataRef.current = data;
    /* eslint-enable react/refs */
  }

  const loadOlder = useCallback(async () => {
    const before = olderCursorRef.current;
    if (before === null || isLoadingOlderRef.current) {
      return;
    }
    const requestedData = seededDataRef.current;
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    setLoadOlderError(false);

    const result = await Result.tryPromise(
      async () => await fetchOlderVersions({ workspaceId, entityId, before }),
    );

    // Discard a response that resolved after the page was rehydrated (entity
    // switch OR same-entity refetch): the re-seed already reset paging for the
    // new data, so applying this would corrupt its cursor and merge a stale
    // page (skipping the boundary version).
    if (seededDataRef.current !== requestedData) {
      return;
    }

    isLoadingOlderRef.current = false;
    setIsLoadingOlder(false);

    if (Result.isError(result)) {
      // `fetchOlderVersions` already throws a converted APIError; capture
      // it for telemetry and surface a toast. Keep the cursor but flag
      // the error so auto-loading pauses (the manual button retries)
      // instead of looping the request.
      getAnalytics().captureError(result.error);
      setLoadOlderError(true);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
      return;
    }

    const older = result.value;
    setAccumulated((current) => {
      const existingIds = new Set(current.map((version) => version.id));
      const next = older.versions.filter(
        (version) => !existingIds.has(version.id),
      );
      if (next.length === 0) {
        return current;
      }
      // Keep the list newest-first: an older page has smaller versionNumbers,
      // so it appends after the current page. The sidebar sorts for display
      // but relies on this order for delete/selection fallbacks.
      return [...current, ...next];
    });
    olderCursorRef.current = older.olderCursor;
    setOlderCursor(older.olderCursor);
  }, [entityId, t, workspaceId]);

  // When the document viewer deep-links to a field from a version older than
  // the newest page (switch to an old version, then reload), the preview
  // resolves via the field-file lookup, but that version is not in
  // `accumulated`, so the sidebar shows no selected row or version actions
  // for it. Walk older pages until the active version surfaces. Self-
  // terminating: it stops once the row appears, the cursor runs out, or a
  // fetch errors. Page size is 50, so this only fires for the rare deep-link
  // to a version outside the newest page.
  const shouldLoadDeepLinkedVersion = Boolean(
    currentFieldId &&
    olderCursor !== null &&
    !isLoadingOlder &&
    !loadOlderError &&
    !accumulated.some((version) => version.file?.fieldId === currentFieldId),
  );

  if (!data) {
    return null;
  }

  const handleSwitchVersion = async (fieldId: string, versionId: string) => {
    const target = accumulated.find((v) => v.id === versionId);
    if (!target?.file) {
      return;
    }
    openFileForEntity({
      id: fieldId,
      entityId,
      label: target.file.fileName,
      fileName: target.file.fileName,
      mimeType: target.file.mimeType,
      pdfFileId: null,
      propertyId: target.file.propertyId,
      workspaceId,
    });
    // If we're already on the document route, sync the URL
    // search so reload + back/forward keep the same version.
    // On non-document routes (matters table inspector), we
    // intentionally do NOT navigate — the user picked a
    // version from sidepeek and expects to stay where they
    // are.
    // Detect "we're on the document route" by structure, not
    // by entityId-as-segment: the path is
    // `/workspaces/{workspaceId}/{viewId}/document` where
    // viewId is the view selector (typically "all"), not the
    // entity id. The previous literal `${entityId}` check
    // never matched in normal navigation, so version switches
    // skipped the URL sync.
    const onDocumentRoute = new RegExp(
      `^/workspaces/${workspaceId}/[^/]+/document(?:/|$|\\?)`,
      "u",
    ).test(pathname);
    if (onDocumentRoute) {
      // Pull the current viewId out of the path (typically
      // "all") instead of swapping it for entityId — the
      // route lives under whichever view the user opened it
      // from, the entity is identified by the search param.
      const segments = pathname.split("/");
      const currentViewId = segments[3] ?? "all";
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId: currentViewId },
        replace: true,
        search: (prev) => ({
          ...prev,
          entity: entityId,
          editing: undefined,
          field: fieldId,
          pdfPage: undefined,
        }),
      });
    }
  };

  const canCompare =
    accumulated.filter(({ file }) => file?.mimeType === DOCX_MIME).length >= 2;

  if (view === "compare") {
    return (
      <div className="bg-background flex h-full min-h-0 flex-col">
        {shouldLoadDeepLinkedVersion && olderCursor !== null && (
          <LoadOlderVersionLifecycle key={olderCursor} loadOlder={loadOlder} />
        )}
        <div className={cn("flex shrink-0 border-b", TOOLBAR_ROW_HEIGHT)}>
          <Button
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-full w-full justify-start gap-2 rounded-none border-0 px-3 font-normal before:rounded-none"
            onClick={() => setView("history")}
            type="button"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
            <span className="truncate">{t("fileDetail.versionHistory")}</span>
          </Button>
        </div>
        <CompareVersionsPanel
          currentFieldId={currentFieldId}
          entityId={entityId}
          versions={accumulated}
          workspaceId={workspaceId}
        />
      </div>
    );
  }

  return (
    <div className="bg-background h-full overflow-y-auto">
      {shouldLoadDeepLinkedVersion && olderCursor !== null && (
        <LoadOlderVersionLifecycle key={olderCursor} loadOlder={loadOlder} />
      )}
      <VersionsSidebar
        currentFieldId={currentFieldId}
        currentVersionId={data.currentVersionId}
        entityId={entityId}
        hasOlderVersions={olderCursor !== null}
        isLoadingOlder={isLoadingOlder}
        loadOlderError={loadOlderError}
        versions={accumulated}
        workspaceId={workspaceId}
        onCompareVersions={canCompare ? () => setView("compare") : undefined}
        onLoadOlder={loadOlder}
        onSwitchVersion={handleSwitchVersion}
      />
    </div>
  );
};

export const useSelectedFileVersionMissing = ({
  enabled,
  fieldId,
  workspaceId,
}: {
  enabled: boolean;
  fieldId: string;
  workspaceId: string;
}): boolean => {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe(() => onStoreChange()),
    [queryClient],
  );
  const getSnapshot = useCallback(() => {
    if (!enabled) {
      return false;
    }

    const error = queryClient.getQueryState(
      fileContentQueryKey({ workspaceId, fieldId }),
    )?.error;
    return APIError.is(error) && error.status === 404;
  }, [enabled, fieldId, queryClient, workspaceId]);
  const isMissing = useSyncExternalStore(subscribe, getSnapshot, () => false);

  return isMissing;
};

const LoadOlderVersionLifecycle = ({
  loadOlder,
}: {
  loadOlder: () => Promise<void>;
}) => {
  useMountEffect(() => {
    detached(loadOlder(), "versions-facet.load-older");
  });
  return null;
};
