import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Skeleton } from "@stll/ui/components/skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import {
  EMPTY_SCREEN_MATTERS_VIDEO,
  EmptyScreen,
} from "@/components/empty-screen";
import { usePermissions } from "@/hooks/use-permissions";
import { pageTitle } from "@/lib/page-title";
import { AlphabetIndex } from "@/routes/_protected.workspaces/-components/alphabet-index";
import { ClientGroupHeader } from "@/routes/_protected.workspaces/-components/client-group-header";
import { MatterCard } from "@/routes/_protected.workspaces/-components/matter-card";
import { MattersTable } from "@/routes/_protected.workspaces/-components/matters-table";
import { MattersToolbar } from "@/routes/_protected.workspaces/-components/matters-toolbar";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";
import type {
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";
import {
  compareWorkspacesByKey,
  groupByClient,
} from "@/routes/_protected.workspaces/-utils";
import { useConfigStore } from "@/stores/config-store";

export const Route = createFileRoute("/_protected/workspaces/")({
  head: () => ({
    meta: [{ title: pageTitle("common.matters") }],
  }),
  component: RouteComponent,
  pendingComponent: () => (
    <div className="grid auto-rows-min gap-4 border-t p-4 md:grid-cols-3">
      <Skeleton className="h-22 w-full rounded-xl" />
      <Skeleton className="h-22 w-full rounded-xl" />
      <Skeleton className="h-22 w-full rounded-xl" />
    </div>
  ),
});

function RouteComponent() {
  const t = useTranslations();
  const { data } = useSuspenseQuery(workspacesOptions);
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  const { sortKey, sortDesc, groupBy, collapsedGroups } = useConfigStore(
    useShallow((s) => ({
      sortKey: s.matters.sortKey,
      sortDesc: s.matters.sortDesc,
      groupBy: s.matters.groupBy,
      collapsedGroups: s.matters.collapsedGroups ?? [],
    })),
  );

  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const workspaces = data.workspaces;
  const canOpenCreateMatter =
    canCreateMatter && workspaces.length < data.workspacesCountLimit;

  const filtered = workspaces.filter((w) => {
    if (!search.trim()) {
      return true;
    }
    const q = search.toLowerCase();
    return (
      w.name.toLowerCase().includes(q) ||
      w.reference.toLowerCase().includes(q) ||
      w.client?.displayName.toLowerCase().includes(q)
    );
  });

  const sorted = filtered.toSorted((a, b) => {
    const cmp = compareWorkspacesByKey(a, b, sortKey);
    return sortDesc ? -cmp : cmp;
  });

  const groups = groupBy === "client" ? groupByClient(sorted) : null;

  const collapsedSet = new Set(collapsedGroups);
  const displayed = groups
    ? groups.flatMap((g) => (collapsedSet.has(g.groupId) ? [] : g.workspaces))
    : sorted;

  useEffect(() => {
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
  });

  return (
    <MattersPageContextMenu canCreateMatter={canOpenCreateMatter}>
      <div className="flex min-h-0 flex-1 flex-col">
        <MattersToolbar
          onSearchChange={setSearch}
          search={search}
          searchRef={searchRef}
        />

        <div className="relative flex-1">
          <div className="absolute inset-0 overflow-y-auto" ref={scrollRef}>
            {sorted.length === 0 ? (
              workspaces.length === 0 ? (
                <EmptyScreen
                  className="min-h-full"
                  description={t("workspaces.emptyMatters.description")}
                  primaryAction={{
                    label: t("workspaces.createNewWorkspace"),
                    icon: PlusIcon,
                    onClick: () => openCreateMatter(),
                  }}
                  mediaPlacement="bottom"
                  title={t("workspaces.emptyMatters.title")}
                  video={{
                    ...EMPTY_SCREEN_MATTERS_VIDEO,
                    title: t("workspaces.emptyMatters.videoLabel"),
                  }}
                />
              ) : (
                <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
                  {t("common.empty")}
                </div>
              )
            ) : (
              <MattersContentView
                canCreateMatter={canOpenCreateMatter}
                displayed={displayed}
                focusIndex={focusIndex}
                groups={groups}
              />
            )}
          </div>
          {groups && groups.length > 0 && (
            <AlphabetIndex
              collapsedGroups={collapsedGroups}
              groups={groups}
              scrollContainerRef={scrollRef}
            />
          )}
        </div>
      </div>
    </MattersPageContextMenu>
  );
}

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
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  if (!canCreateMatter) {
    return children;
  }

  return (
    <div
      className="contents"
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        const x = event.clientX;
        const y = event.clientY;
        setAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setOpen(true);
      }}
    >
      {children}
      <Menu
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setAnchor(null);
          }
        }}
        open={open}
      >
        <MenuTrigger
          nativeButton={false}
          render={<span className="sr-only" />}
        />
        <MenuPopup anchor={anchor ?? undefined}>
          <MenuItem onClick={() => openCreateMatter()}>
            <PlusIcon />
            {t("workspaces.createNewWorkspace")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};

type MattersContentViewProps = {
  canCreateMatter: boolean;
  displayed: Workspace[];
  groups: WorkspaceGroup[] | null;
  focusIndex: number;
};

const MattersContentView = ({
  canCreateMatter,
  displayed,
  groups,
  focusIndex,
}: MattersContentViewProps) => {
  const t = useTranslations();
  const gridRef = useRef<HTMLDivElement>(null);
  const viewMode = useConfigStore((s) => s.matters.viewMode);
  const collapsedGroups = useConfigStore(
    useShallow((s) => s.matters.collapsedGroups ?? []),
  );
  const toggleGroupCollapsed = useConfigStore((s) => s.toggleGroupCollapsed);
  return (
    <div className="p-2">
      {viewMode === "table" ? (
        <MattersTable
          collapsedGroups={collapsedGroups}
          focusIndex={focusIndex}
          groups={groups}
          onToggleGroup={toggleGroupCollapsed}
          workspaces={displayed}
        />
      ) : groups && groups.length > 0 ? (
        <div className="grid auto-rows-min gap-3 md:grid-cols-3" ref={gridRef}>
          {groups.map((group) => {
            const collapsed = collapsedGroups.includes(group.groupId);
            const firstWs = group.workspaces.at(0);
            const baseIndex = firstWs ? displayed.indexOf(firstWs) : 0;
            return (
              <Fragment key={group.groupId}>
                <ClientGroupHeader
                  collapsed={collapsed}
                  group={group}
                  onToggle={() => toggleGroupCollapsed(group.groupId)}
                  personalLabel={t("workspaces.parties.personalLabel")}
                />
                {!collapsed &&
                  group.workspaces.map((workspace, i) => (
                    <MatterCard
                      canCreateMatter={canCreateMatter}
                      focused={focusIndex === baseIndex + i}
                      hideClientName
                      key={workspace.id}
                      workspace={workspace}
                    />
                  ))}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="grid auto-rows-min gap-3 md:grid-cols-3" ref={gridRef}>
          {displayed.map((workspace, i) => (
            <MatterCard
              canCreateMatter={canCreateMatter}
              focused={focusIndex === i}
              key={workspace.id}
              workspace={workspace}
            />
          ))}
        </div>
      )}
    </div>
  );
};
