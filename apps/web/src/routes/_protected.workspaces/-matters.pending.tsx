import { useSyncExternalStore } from "react";
import type { ReactNode, Ref } from "react";

import { useSearch } from "@tanstack/react-router";

import { usePendingCache } from "@/components/pending-cache";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { cachedMatterCreationOpen } from "@/lib/workspaces/cached-matter-creation.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { ClientGroupSectionsPending } from "@/routes/_protected.workspaces/-components/client-group-section.pending";
import { MatterCardGridPending } from "@/routes/_protected.workspaces/-components/matter-card.pending";
import { MattersTablePending } from "@/routes/_protected.workspaces/-components/matters-table.pending";
import { MattersToolbarFace } from "@/routes/_protected.workspaces/-components/matters-toolbar.pending";
import { useConfigStore } from "@/stores/config-store";
import type { MattersConfig } from "@/stores/config-store";

type MattersPageShellProps = {
  toolbar: ReactNode;
  /** Between the toolbar and the matters: the active filters. */
  notices?: ReactNode;
  /** The scrolling region the matters sit in, for a page that scrolls it. */
  scrollRef?: Ref<HTMLDivElement> | undefined;
  /** Over the scrolling region: the alphabet index. */
  aside?: ReactNode;
  /** The matters, or what stands in for them. */
  children: ReactNode;
};

/**
 * The matters page's one layout, drawn by both phases: the toolbar, the
 * active filters, and the matters scrolling under them. The loaded page
 * fills it with the live toolbar and the matters; the loading view with the
 * toolbar's face and placeholder matters.
 */
export const MattersPageShell = ({
  aside,
  children,
  notices,
  scrollRef,
  toolbar,
}: MattersPageShellProps) => (
  <div className="flex min-h-0 flex-1 flex-col">
    {toolbar}
    {notices}
    <div className="relative flex-1">
      <div className="absolute inset-0 overflow-y-auto" ref={scrollRef}>
        {children}
      </div>
      {aside}
    </div>
  </div>
);

/** The padding the matters sit in, in either layout. */
export const MATTERS_CONTENT_CLASS = "p-2";

/**
 * The matters while they load, in the member's layout: the table with their
 * columns, the grid grouped by client, or the flat grid.
 */
export const MattersContentPending = ({
  config,
}: {
  config: Pick<
    MattersConfig,
    "groupBy" | "hiddenColumns" | "sortDesc" | "sortKey" | "viewMode"
  >;
}) => {
  if (config.viewMode === "table") {
    return (
      <div className={MATTERS_CONTENT_CLASS}>
        <MattersTablePending
          hiddenColumns={config.hiddenColumns}
          sort={{ key: config.sortKey, desc: config.sortDesc }}
        />
      </div>
    );
  }
  return (
    <div className={MATTERS_CONTENT_CLASS}>
      {config.groupBy === "client" ? (
        <ClientGroupSectionsPending />
      ) : (
        <MatterCardGridPending />
      )}
    </div>
  );
};

const subscribeToConfig = (onChange: () => void) =>
  useConfigStore.subscribe(onChange);
const readMattersConfig = () => useConfigStore.getState().matters;
const notReadYet = () => undefined;

/**
 * The member's matters layout as this browser keeps it, once the page can
 * read it: never during the server's paint or the hydration pass (the server
 * has no browser storage), so the first paint claims no layout it might take
 * back, and the kept one right after.
 */
const useKeptMattersConfig = (): MattersConfig | undefined =>
  useSyncExternalStore(subscribeToConfig, readMattersConfig, notReadYet);

/**
 * The matters page in its pending phase: the toolbar's face, and the
 * matters in the member's layout once this browser's copy of it is read
 * (nothing claimed before). "New matter" shows only where the cache already
 * says the loaded toolbar will offer it.
 */
const MattersPendingView = () => {
  const archived = useSearch({
    strict: false,
    select: (search) => search.status === "archived",
  });
  const config = useKeptMattersConfig();
  const queryClient = usePendingCache();
  const canCreate =
    queryClient !== null &&
    cachedRoleGrants(queryClient, { workspace: ["create"] }) &&
    cachedMatterCreationOpen(queryClient);
  return (
    <MattersPageShell
      toolbar={
        <MattersToolbarFace
          archived={archived}
          canCreate={canCreate}
          config={config}
        />
      }
    >
      {config === undefined ? null : <MattersContentPending config={config} />}
    </MattersPageShell>
  );
};

export const MattersPending = framePendingView(MattersPendingView);
