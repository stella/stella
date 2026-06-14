import { lazy, Suspense, useEffect, useMemo } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useAIKeyGate } from "@/components/require-ai-key";
import type { WorkspaceView } from "@/lib/types";
import {
  EmptyState,
  FilteredEmptyState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { GroupedTableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout";
import {
  DEFAULT_TABLE_COLUMN_MIN_SIZE,
  useTableColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { workspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useSyncJustificationChunks } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  useEntitiesWindowOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { toTableEntities } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const loadTableDevtools = async () => {
  const tableDevtoolsModule =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools");

  return tableDevtoolsModule;
};

// Keeps the devtools package out of production bundles.
const TableDevtools = import.meta.env.DEV ? lazy(loadTableDevtools) : null;

type TableLayoutProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const TableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const { openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  if (view.layout.groupByPropertyId) {
    return <GroupedTableLayout view={view} workspaceId={workspaceId} />;
  }

  return <FlatTableLayout view={view} workspaceId={workspaceId} />;
};

const FlatTableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const t = useTranslations();
  const tableState = useTableState({ workspaceId, view });
  const updateView = useUpdateView(workspaceId);

  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const columns = useTableColumns({ properties, view });
  const fieldIds = useMemo(
    () =>
      visibleEntityFieldIds({
        hiddenProperties: view.layout.hiddenProperties,
        properties,
      }),
    [properties, view.layout.hiddenProperties],
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(
      useEntitiesWindowOptions({
        workspaceId,
        filters: view.layout.filters,
        sorts: view.layout.sorts,
        limit: DEFAULT_ENTITY_WINDOW_SIZE,
        excludedKinds: ["folder", "task"],
        fieldMode: "visible",
        fieldIds,
      }),
    );

  const treeData = useMemo(
    () =>
      toTableEntities(
        data.pages
          .flatMap((window) => window.entities)
          .filter(
            (entity) => entity.kind !== "folder" && entity.kind !== "task",
          ),
      ),
    [data.pages],
  );
  const justificationEntityIdChunks = useMemo(
    () =>
      data.pages.map((page) => page.entities.map((entity) => entity.entityId)),
    [data.pages],
  );
  useSyncJustificationChunks({
    workspaceId,
    entityIdChunks: justificationEntityIdChunks,
  });

  // Resolve the row selection to entities for chrome outside the
  // table (the view toolbar's bulk actions menu).
  const rowSelection = useTableStore((s) => s.rowSelection[view.id]);
  const setSelectedEntities = useTableStore((s) => s.setSelectedEntities);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- derived state (resolves row selection to entities) synced into the table store; compute in render or a selector
  useEffect(() => {
    const selected = rowSelection ?? {};
    const result: TableTreeNode[] = [];
    const visit = (nodes: TableTreeNode[] | undefined) => {
      if (!nodes) {
        return;
      }

      for (const node of nodes) {
        if (selected[node.entityId]) {
          result.push(node);
        }
        visit(node.children);
      }
    };
    visit(treeData);
    setSelectedEntities(view.id, result);
  }, [rowSelection, treeData, view.id, setSelectedEntities]);

  const table = useTable({
    features: workspaceTableFeatures,
    columnResizeMode: "onChange",
    data: treeData,
    columns,
    defaultColumn: {
      minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE,
    },
    manualSorting: true,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
    ...tableState.listeners,
  });

  if (table.getRowModel().rows.length === 0) {
    if (view.layout.filters.length > 0) {
      return (
        <FilteredEmptyState
          onClearFilters={() =>
            updateView.mutate({
              viewId: view.id,
              layout: { ...view.layout, filters: [] },
            })
          }
        />
      );
    }
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.noItems")}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <>
      <WorkspaceTable
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => {
          void fetchNextPage();
        }}
        table={table}
        contentMode={tableState.contentMode}
        workspaceId={workspaceId}
      />
      {TableDevtools ? (
        <ClientOnly>
          <Suspense fallback={null}>
            <TableDevtools table={table} />
          </Suspense>
        </ClientOnly>
      ) : null}
    </>
  );
};
