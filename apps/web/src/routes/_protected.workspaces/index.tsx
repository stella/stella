import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";
import { useShallow } from "zustand/shallow";

import { Button } from "@stll/ui/components/button";
import { Frame } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Separator } from "@stll/ui/components/separator";
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { cn } from "@stll/ui/lib/utils";

import {
  EMPTY_SCREEN_MATTERS_VIDEO,
  EmptyScreen,
} from "@/components/empty-screen";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { pageTitle } from "@/lib/page-title";
import { AlphabetIndex } from "@/routes/_protected.workspaces/-components/alphabet-index";
import { ClientGroupHeader } from "@/routes/_protected.workspaces/-components/client-group-header";
import { MatterCard } from "@/routes/_protected.workspaces/-components/matter-card";
import { MattersTable } from "@/routes/_protected.workspaces/-components/matters-table";
import { MattersToolbar } from "@/routes/_protected.workspaces/-components/matters-toolbar";
import { ActiveFilterChips } from "@/routes/_protected.workspaces/-filters/active-filter-chips";
import { applyMattersFilters } from "@/routes/_protected.workspaces/-filters/filter-pipeline";
import { useColumnLabels } from "@/routes/_protected.workspaces/-hooks/use-column-labels";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import { getMatterOrganizationResetPatch } from "@/routes/_protected.workspaces/-organization-reset";
import {
  workspacesKeys,
  workspacesOptions,
} from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";
import type {
  MattersColumnId,
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";
import {
  compareWorkspacesByKey,
  groupByClient,
} from "@/routes/_protected.workspaces/-utils";
import { useConfigStore } from "@/stores/config-store";

const searchSchema = v.object({
  // Client id to scroll into view and flash on arrival (set by the matter
  // breadcrumb's company link). Cleared by the route once consumed.
  focusClient: v.optional(v.string()),
});

export const Route = createFileRoute("/_protected/workspaces/")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("common.matters") }],
  }),
  component: RouteComponent,
  pendingComponent: MattersPending,
});

const FOCUS_FLASH_MS = 1500;

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, isFetching } = useSuspenseQuery(
    workspacesOptions(activeOrganizationId),
  );
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const resetMatterVisibilityState = useConfigStore((s) => s.updateMatters);
  const toggleGroupCollapsed = useConfigStore((s) => s.toggleGroupCollapsed);
  const navigate = useNavigate();
  const focusClient = Route.useSearch({ select: (s) => s.focusClient });

  const { sortKey, sortDesc, groupBy, collapsedGroups, filters } =
    useConfigStore(
      useShallow((s) => ({
        sortKey: s.matters.sortKey,
        sortDesc: s.matters.sortDesc,
        groupBy: s.matters.groupBy,
        collapsedGroups: s.matters.collapsedGroups,
        filters: s.matters.filters,
      })),
    );

  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousOrganizationIdRef = useRef(activeOrganizationId);

  // On org change this resets local search AND mutates the config store
  // (resetMatterVisibilityState) and invalidates the workspaces query. A `key`
  // remount would only reset local state, not the store reset or invalidation,
  // and this is a router-owned route component with no parent to key, so it
  // stays an effect.
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- org-change reset performs a zustand store reset + query invalidation alongside local state; lift-to-key cannot replicate the store/cache side effects
  useEffect(() => {
    if (previousOrganizationIdRef.current === activeOrganizationId) {
      return;
    }

    previousOrganizationIdRef.current = activeOrganizationId;
    setSearch("");
    resetMatterVisibilityState(getMatterOrganizationResetPatch());
    void queryClient.invalidateQueries({
      queryKey: workspacesKeys.list(activeOrganizationId),
    });
  }, [activeOrganizationId, queryClient, resetMatterVisibilityState]);

  const workspaces = data.workspaces;
  const canOpenCreateMatter =
    canCreateMatter && workspaces.length < data.workspacesCountLimit;

  const searched = workspaces.filter((w) => {
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

  const filtered = applyMattersFilters(searched, filters);

  const sorted = filtered.toSorted((a, b) => {
    const cmp = compareWorkspacesByKey(a, b, sortKey);
    return sortDesc ? -cmp : cmp;
  });

  const groups = groupBy === "client" ? groupByClient(sorted) : null;

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

  const focusOnClient = useEffectEvent((clientId: string) => {
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

    void navigate({ to: "/workspaces", search: {}, replace: true });
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
  }, [focusClient]);

  return (
    <MattersPageContextMenu canCreateMatter={canOpenCreateMatter}>
      <div className="flex min-h-0 flex-1 flex-col">
        <MattersToolbar
          onSearchChange={setSearch}
          search={search}
          searchRef={searchRef}
        />
        <ActiveFilterChips workspaces={workspaces} />

        <div className="relative flex-1">
          <div className="absolute inset-0 overflow-y-auto" ref={scrollRef}>
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
                return (
                  <div className="grid auto-rows-min gap-4 border-t p-4 md:grid-cols-3">
                    <Skeleton className="h-22 w-full rounded-xl" />
                    <Skeleton className="h-22 w-full rounded-xl" />
                    <Skeleton className="h-22 w-full rounded-xl" />
                  </div>
                );
              }
              if (workspaces.length === 0) {
                return (
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
                );
              }
              return (
                <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
                  {t("common.empty")}
                </div>
              );
            })()}
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

const SKELETON_TABLE_ROW_KEYS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
] as const;

const SKELETON_CARD_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

// Mirrors the fixed widths in matters-table.tsx's COLUMNS model so the pending
// table reserves the same column geometry. `name` is the flexible first column
// (no fixed width) and is always rendered; the rest follow ALL_COLUMNS order.
const SKELETON_COLUMN_WIDTHS: Record<MattersColumnId, string> = {
  client: "240px",
  team: "160px",
  reference: "120px",
  entityCount: "96px",
  lastActivityAt: "140px",
  createdAt: "120px",
};

type SkeletonColumn =
  | { id: "name"; width?: undefined }
  | { id: MattersColumnId; width: string };

// Faithful placeholder of the matters page during route suspension: the real
// toolbar chrome plus a content skeleton that follows the live view mode, so the
// page does not jump or change shape when the suspended query resolves.
function MattersPending() {
  const viewMode = useConfigStore((s) => s.matters.viewMode);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MattersToolbarSkeleton />
      <div className="relative flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          <div className="p-2">
            {viewMode === "table" ? (
              <MattersTableSkeleton />
            ) : (
              <MatterCardGridSkeleton />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Inert mirror of MattersToolbar: same h-12 bordered row, search input, sort and
// view-toggle ghost buttons, and a trailing create button. Real (disabled)
// primitives keep sizing, radii, and spacing identical to the live toolbar.
const MattersToolbarSkeleton = () => {
  const t = useTranslations();
  const config = useConfigStore(useShallow((s) => s.matters));
  const sortLabels = useSortLabels();

  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b px-2",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Input
        className="w-64 max-w-[40%]"
        disabled
        placeholder={t("common.search")}
        size="sm"
      />
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Button disabled size="xs" variant="ghost">
        <SlidersHorizontalIcon />
        <span className="text-muted-foreground text-xs">
          {sortLabels[config.sortKey]}
        </span>
        {config.sortDesc ? (
          <ArrowDownIcon className="size-3" />
        ) : (
          <ArrowUpIcon className="size-3" />
        )}
      </Button>
      <Button disabled size="xs" variant="ghost">
        {config.viewMode === "grid" ? (
          <>
            <ListIcon />
            {t("workspaces.views.layouts.table")}
          </>
        ) : (
          <>
            <LayoutGridIcon />
            {t("workspaces.views.layouts.grid")}
          </>
        )}
      </Button>
      <Button className="ms-auto" disabled size="xs">
        <PlusIcon />
        {t("workspaces.newMatter")}
      </Button>
    </div>
  );
};

// Table skeleton derived from the same column model the real MattersTable reads
// (ALL_COLUMNS order, fixed widths, name always first) gated by the live
// hiddenColumns set, so columns appear, disappear, or move in lockstep.
const MattersTableSkeleton = () => {
  const columnLabels = useColumnLabels();
  const sortLabels = useSortLabels();
  const hiddenColumns = useConfigStore(
    useShallow((s) => s.matters.hiddenColumns),
  );

  const hiddenColumnSet = new Set(hiddenColumns);
  const columns: SkeletonColumn[] = [
    { id: "name" },
    ...ALL_COLUMNS.filter((id) => !hiddenColumnSet.has(id)).map((id) => ({
      id,
      width: SKELETON_COLUMN_WIDTHS[id],
    })),
  ];

  const headerLabel = (id: SkeletonColumn["id"]): string =>
    id === "name" ? sortLabels.name : columnLabels[id];

  return (
    <Frame>
      <Table className="table-fixed">
        <colgroup>
          {columns.map((col) => (
            <col
              key={col.id}
              style={col.width ? { width: col.width } : undefined}
            />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.id}>
                <span className="truncate">{headerLabel(col.id)}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {SKELETON_TABLE_ROW_KEYS.map((rowKey) => (
            <TableRow key={rowKey}>
              {columns.map((col) => (
                <TableCell key={col.id}>
                  <SkeletonTableCell columnId={col.id} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
};

const SkeletonTableCell = ({
  columnId,
}: {
  columnId: SkeletonColumn["id"];
}) => {
  if (columnId === "name") {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="size-2 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  }
  if (columnId === "team") {
    return (
      <div className="flex items-center -space-x-1">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="size-6 rounded-full" />
      </div>
    );
  }
  if (columnId === "entityCount") {
    return <Skeleton className="h-4 w-6" />;
  }
  return <Skeleton className="h-4 w-3/5" />;
};

// Card grid skeleton mirroring the MatterCard grid: md:grid-cols-3 of bordered,
// rounded-xl cards with the name+reference, items, and avatars+activity lines.
const MatterCardGridSkeleton = () => (
  <div className="grid auto-rows-min gap-3 md:grid-cols-3">
    {SKELETON_CARD_KEYS.map((cardKey) => (
      <div
        className="bg-card flex flex-col gap-1 overflow-hidden rounded-xl border px-3 py-2"
        key={cardKey}
      >
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
        <Skeleton className="-mt-1 h-3 w-24" />
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3 w-20" />
          <div className="flex items-center gap-2">
            <div className="flex items-center -space-x-1">
              <Skeleton className="size-5 rounded-full" />
              <Skeleton className="size-5 rounded-full" />
            </div>
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      </div>
    ))}
  </div>
);

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
  return (
    <div className="p-2">
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
            <div
              className="grid auto-rows-min gap-3 md:grid-cols-3"
              ref={gridRef}
            >
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
          );
        }
        return (
          <div
            className="grid auto-rows-min gap-3 md:grid-cols-3"
            ref={gridRef}
          >
            {displayed.map((workspace, i) => (
              <MatterCard
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
