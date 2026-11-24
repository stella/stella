import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";
import { EntityActions } from "@stll/ui/entity-actions";
import { PlusIcon } from "@stll/ui/icons";

import { EmptyScreen } from "@/components/empty-screen";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormattingLocale } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  isMatterInStatusView,
  matterCardDragMode,
} from "@/lib/workspaces/archived-matters.logic";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { captureDialogReturnFocus } from "@/lib/workspaces/dialog-return-focus";
import {
  workspacesKeys,
  workspacesRouteOptions,
} from "@/lib/workspaces/queries";
import type { Workspace, WorkspaceGroup } from "@/lib/workspaces/types";
import { AlphabetIndex } from "@/routes/_protected.workspaces/-components/alphabet-index";
import { ClientGroupSection } from "@/routes/_protected.workspaces/-components/client-group-section";
import { MatterCard } from "@/routes/_protected.workspaces/-components/matter-card";
import { MATTER_CARD_GRID_CLASS } from "@/routes/_protected.workspaces/-components/matter-card.pending";
import { MattersTable } from "@/routes/_protected.workspaces/-components/matters-table";
import { MattersToolbar } from "@/routes/_protected.workspaces/-components/matters-toolbar";
import { ActiveFilterChips } from "@/routes/_protected.workspaces/-filters/active-filter-chips";
import { applyMattersFilters } from "@/routes/_protected.workspaces/-filters/filter-pipeline";
import { filterWorkspacesBySearch } from "@/routes/_protected.workspaces/-filters/matters-search.logic";
import { useMatterClientDrop } from "@/routes/_protected.workspaces/-hooks/use-matter-client-drop";
import {
  compareWorkspacesByKey,
  groupByClient,
} from "@/routes/_protected.workspaces/-utils";
import { useConfigStore } from "@/stores/config-store";

import {
  MATTERS_CONTENT_CLASS,
  MattersContentPending,
  MattersPageShell,
} from "./-matters.pending";

const routeApi = getRouteApi("/_protected/workspaces/");

const FOCUS_FLASH_MS = 1500;

/** The matters list: the toolbar over the organization's matters. */
export function MattersPage() {
  const activeOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [prevOrganizationId, setPrevOrganizationId] =
    useState(activeOrganizationId);
  const [resetExternalState, setResetExternalState] = useState(false);
  if (prevOrganizationId !== activeOrganizationId) {
    setPrevOrganizationId(activeOrganizationId);
    setResetExternalState(true);
  }

  return (
    <MattersContent
      activeOrganizationId={activeOrganizationId}
      key={activeOrganizationId}
      resetExternalState={resetExternalState}
    />
  );
}

const MattersContent = ({
  activeOrganizationId,
  resetExternalState,
}: {
  activeOrganizationId: string;
  resetExternalState: boolean;
}) => {
  const t = useTranslations();
  const locale = useFormattingLocale();
  const queryClient = useQueryClient();
  const status = routeApi.useSearch({ select: (s) => s.status });
  const { data, isFetching } = useSuspenseQuery(
    workspacesRouteOptions(activeOrganizationId, status),
  );
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const resetMatterVisibilityState = useConfigStore((s) => s.updateMatters);
  const toggleGroupCollapsed = useConfigStore((s) => s.toggleGroupCollapsed);
  const navigate = useNavigate();
  const focusClient = routeApi.useSearch({ select: (s) => s.focusClient });

  const {
    sortKey,
    sortDesc,
    groupBy,
    collapsedGroups,
    filters,
    hiddenColumns,
    viewMode,
  } = useConfigStore(
    useShallow((s) => ({
      sortKey: s.matters.sortKey,
      sortDesc: s.matters.sortDesc,
      groupBy: s.matters.groupBy,
      collapsedGroups: s.matters.collapsedGroups,
      filters: s.matters.filters,
      hiddenColumns: s.matters.hiddenColumns,
      viewMode: s.matters.viewMode,
    })),
  );

  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    if (!resetExternalState) {
      return;
    }
    resetMatterVisibilityState({ collapsedGroups: [], filters: {} });
    detached(
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.list(activeOrganizationId),
      }),
      "workspaces.invalidate",
    );
  });

  const workspaces = data.workspaces.filter((matter) =>
    isMatterInStatusView(matter.status, status),
  );
  const canOpenCreateMatter =
    canCreateMatter && data.creationCapacity.canCreate;

  const searched = filterWorkspacesBySearch(workspaces, search);

  const filtered = applyMattersFilters(searched, filters);

  const sorted = filtered.toSorted((a, b) => {
    const cmp = compareWorkspacesByKey(a, b, sortKey, locale);
    return sortDesc ? -cmp : cmp;
  });

  const groups = groupBy === "client" ? groupByClient(sorted, locale) : null;

  const collapsedSet = new Set(collapsedGroups);
  const displayed = groups
    ? groups.flatMap((g) => (collapsedSet.has(g.groupId) ? [] : g.workspaces))
    : sorted;

  useExternalSyncEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearch("");
        setFocusIndex(-1);
        return;
      }

      if (
        displayed.length === 0 ||
        document.activeElement instanceof HTMLInputElement
      ) {
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setFocusIndex((prev) => (prev < displayed.length - 1 ? prev + 1 : 0));
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setFocusIndex((prev) => (prev > 0 ? prev - 1 : displayed.length - 1));
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [displayed]);

  const focusOnClient = useLatestCallback((clientId: string) => {
    if (collapsedSet.has(clientId)) {
      toggleGroupCollapsed(clientId);
    }

    // Defer the DOM read to the next frame so an expanded group has been
    // committed before we scroll to and flash it.
    requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector<HTMLElement>(
        `[data-group-id="${CSS.escape(clientId)}"]`,
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.add("ring-2", "ring-primary", "rounded-md");
        setTimeout(() => {
          target.classList.remove("ring-2", "ring-primary", "rounded-md");
        }, FOCUS_FLASH_MS);
      }
    });

    detached(
      navigate({ to: "/workspaces", search: {}, replace: true }),
      "workspaces.navigate",
    );
  });

  // Scroll the company group into view and flash it when arriving from the
  // matter breadcrumb's company link, then clear the one-shot search param so a
  // refresh or back-navigation does not re-trigger it. The flash is a
  // self-contained DOM tween (not React-owned) so clearing the param right away
  // cannot cut it short.
  useExternalSyncEffect(() => {
    if (focusClient) {
      focusOnClient(focusClient);
    }
  }, [focusClient, focusOnClient]);

  return (
    <MattersPageContextMenu canCreateMatter={canOpenCreateMatter}>
      <MattersPageShell
        aside={
          groups && groups.length > 0 ? (
            <AlphabetIndex
              collapsedGroups={collapsedGroups}
              groups={groups}
              scrollContainerRef={scrollRef}
            />
          ) : null
        }
        notices={<ActiveFilterChips workspaces={workspaces} />}
        scrollRef={scrollRef}
        toolbar={
          <MattersToolbar
            status={status}
            onStatusChange={(nextStatus) => {
              setFocusIndex(-1);
              detached(
                navigate({ to: "/workspaces", search: { status: nextStatus } }),
                "workspaces.status",
              );
            }}
            onSearchChange={setSearch}
            search={search}
            searchRef={searchRef}
          />
        }
      >
        {(() => {
          if (sorted.length > 0) {
            return (
              <MattersContentView
                allWorkspaces={workspaces}
                displayed={displayed}
                focusIndex={focusIndex}
                groups={groups}
              />
            );
          }
          if (workspaces.length === 0 && isFetching) {
            // A refetch over no matters: the layout's placeholders, as while
            // the page first loaded, not an empty page.
            return (
              <MattersContentPending
                config={{ groupBy, hiddenColumns, sortDesc, sortKey, viewMode }}
              />
            );
          }
          if (workspaces.length === 0 && status === WORKSPACE_STATUS.active) {
            return (
              <EmptyScreen
                className="min-h-full"
                description={t("workspaces.emptyMatters.description")}
                primaryAction={{
                  label: t("workspaces.createNewWorkspace"),
                  icon: PlusIcon,
                  onClick: (event) =>
                    openCreateMatter({ opener: event.currentTarget }),
                }}
                title={t("workspaces.emptyMatters.title")}
              />
            );
          }
          return (
            <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
              {t("common.empty")}
            </div>
          );
        })()}
      </MattersPageShell>
    </MattersPageContextMenu>
  );
};

type MattersPageContextMenuProps = {
  canCreateMatter: boolean;
  children: ReactNode;
};

const MattersPageContextMenu = ({
  canCreateMatter,
  children,
}: MattersPageContextMenuProps): ReactNode => {
  const t = useTranslations();
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  if (!canCreateMatter) {
    return children;
  }

  return (
    <EntityActions
      actions={[
        {
          label: t("workspaces.createNewWorkspace"),
          icon: <PlusIcon />,
          onClick: () => {
            const opener = captureDialogReturnFocus().current;
            openCreateMatter(opener === null ? {} : { opener });
          },
        },
      ]}
      label={t("workspaces.createNewWorkspace")}
    >
      {children}
    </EntityActions>
  );
};

type MattersContentViewProps = {
  displayed: Workspace[];
  allWorkspaces: readonly Workspace[];
  groups: WorkspaceGroup[] | null;
  focusIndex: number;
};

const MattersContentView = ({
  displayed,
  allWorkspaces,
  groups,
  focusIndex,
}: MattersContentViewProps) => {
  const t = useTranslations();
  const gridRef = useRef<HTMLDivElement>(null);
  const viewMode = useConfigStore((s) => s.matters.viewMode);
  const collapsedGroups = useConfigStore(
    useShallow((s) => s.matters.collapsedGroups),
  );
  const toggleGroupCollapsed = useConfigStore((s) => s.toggleGroupCollapsed);
  const canReassignClient = usePermissions({ workspace: ["update"] });
  const matterClientDrop = useMatterClientDrop();
  return (
    <div className={MATTERS_CONTENT_CLASS}>
      {(() => {
        if (viewMode === "table") {
          return (
            <MattersTable
              allWorkspaces={allWorkspaces}
              collapsedGroups={collapsedGroups}
              focusIndex={focusIndex}
              groups={groups}
              onToggleGroup={toggleGroupCollapsed}
              workspaces={displayed}
            />
          );
        }
        if (groups && groups.length > 0) {
          return (
            <div className={MATTER_CARD_GRID_CLASS} ref={gridRef}>
              {groups.map((group) => {
                const collapsed = collapsedGroups.includes(group.groupId);
                const firstWs = group.workspaces.at(0);
                const baseIndex = firstWs ? displayed.indexOf(firstWs) : 0;
                return (
                  <ClientGroupSection
                    collapsed={collapsed}
                    group={group}
                    key={group.groupId}
                    onMatterDrop={
                      canReassignClient ? matterClientDrop.onMatterDrop : null
                    }
                    onToggle={() => toggleGroupCollapsed(group.groupId)}
                    personalLabel={t("workspaces.parties.personalLabel")}
                  >
                    {!collapsed &&
                      group.workspaces.map((workspace, i) => (
                        <MatterCard
                          drag={matterCardDragMode(
                            workspace.status,
                            canReassignClient,
                          )}
                          focused={focusIndex === baseIndex + i}
                          hideClientName
                          key={workspace.id}
                          workspace={workspace}
                        />
                      ))}
                  </ClientGroupSection>
                );
              })}
            </div>
          );
        }
        return (
          <div className={MATTER_CARD_GRID_CLASS} ref={gridRef}>
            {displayed.map((workspace, i) => (
              <MatterCard
                drag="none"
                focused={focusIndex === i}
                key={workspace.id}
                workspace={workspace}
              />
            ))}
          </div>
        );
      })()}
    </div>
  );
};
