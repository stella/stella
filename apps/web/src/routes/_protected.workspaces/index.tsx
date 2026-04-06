import { Fragment, useEffect, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";

import { pageTitle } from "@/lib/page-title";
import { ClientGroupHeader } from "@/routes/_protected.workspaces/-components/client-group-header";
import { MatterCard } from "@/routes/_protected.workspaces/-components/matter-card";
import { MattersTable } from "@/routes/_protected.workspaces/-components/matters-table";
import { MattersToolbar } from "@/routes/_protected.workspaces/-components/matters-toolbar";
import { useDeleteWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";
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

  const { clientFilter, sortKey, sortDesc, groupBy } = useConfigStore(
    useShallow((s) => ({
      clientFilter: s.matters.clientFilter,
      sortKey: s.matters.sortKey,
      sortDesc: s.matters.sortDesc,
      groupBy: s.matters.groupBy,
    })),
  );

  const [search, setSearch] = useState("");
  const [focusIndex, setFocusIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  const workspaces = data.workspaces;

  const filtered = workspaces
    .filter((w) => !clientFilter || w.client?.id === clientFilter)
    .filter((w) => {
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

  const displayed = groups ? groups.flatMap((g) => g.workspaces) : sorted;

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
    <div className="flex min-h-0 flex-1 flex-col">
      <MattersToolbar
        onSearchChange={setSearch}
        search={search}
        searchRef={searchRef}
      />

      <div className="flex-1 overflow-y-auto">
        {displayed.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
            {workspaces.length === 0
              ? t("workspaces.noMatters")
              : t("common.empty")}
          </div>
        ) : (
          <MattersContentView
            displayed={displayed}
            focusIndex={focusIndex}
            groups={groups}
          />
        )}
      </div>
    </div>
  );
}

type MattersContentViewProps = {
  displayed: Workspace[];
  groups: WorkspaceGroup[] | null;
  focusIndex: number;
};

const MattersContentView = ({
  displayed,
  groups,
  focusIndex,
}: MattersContentViewProps) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const t = useTranslations();
  const viewMode = useConfigStore((s) => s.matters.viewMode);
  const deleteWorkspace = useDeleteWorkspace();

  const handleDelete = (workspaceId: string) => {
    if (deleteWorkspace.isPending) {
      return;
    }
    const toastId = toastManager.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });
    deleteWorkspace.mutate(
      { workspaceId },
      {
        onSuccess: () =>
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          }),
        onError: () =>
          toastManager.update(toastId, {
            title: t("errors.failedToDeleteWorkspace"),
            type: "error",
          }),
      },
    );
  };

  return (
    <div className="p-2">
      {viewMode === "table" ? (
        <MattersTable
          focusIndex={focusIndex}
          groups={groups}
          workspaces={displayed}
        />
      ) : groups && groups.length > 0 ? (
        <div className="grid auto-rows-min gap-3 md:grid-cols-3" ref={gridRef}>
          {groups.map((group) => {
            const firstWs = group.workspaces.at(0);
            const baseIndex = firstWs ? displayed.indexOf(firstWs) : 0;
            return (
              <Fragment key={group.groupId}>
                <ClientGroupHeader
                  clientId={group.clientId}
                  clientName={group.clientName}
                  matterCount={group.workspaces.length}
                />
                {group.workspaces.map((workspace, i) => (
                  <MatterCard
                    focused={focusIndex === baseIndex + i}
                    hideClientName
                    key={workspace.id}
                    onDelete={handleDelete}
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
              focused={focusIndex === i}
              key={workspace.id}
              onDelete={handleDelete}
              workspace={workspace}
            />
          ))}
        </div>
      )}
    </div>
  );
};
