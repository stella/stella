import { lazy, Suspense, useMemo } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useAIKeyGate } from "@/components/require-ai-key";
import { useMountEffect } from "@/hooks/use-effect";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import {
  EmptyState,
  FilteredEmptyState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { GroupedTableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout";
import { MobileTableOrientationGate } from "@/routes/_protected.workspaces/$workspaceId/-components/table/mobile-table-orientation-gate";
import {
  DEFAULT_TABLE_COLUMN_MIN_SIZE,
  useTableColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { workspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import { useSyncJustificationChunks } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useSyncSelectedEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-selected-entities";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  useEntitiesWindowOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { toTableEntities } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const loadTableDevtoolsGate = async () => {
  const tableDevtoolsModule =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools-gate");

  return tableDevtoolsModule;
};

// Keeps the devtools package out of production bundles.
const TableDevtoolsGate = import.meta.env.DEV
  ? lazy(loadTableDevtoolsGate)
  : null;

type TableLayoutProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

type WorkspaceTableKeyInput = {
  workspaceId: string;
  viewId: string;
};

const getWorkspaceTableKey = ({
  workspaceId,
  viewId,
}: WorkspaceTableKeyInput) => `workspace-table:${workspaceId}:${viewId}`;

export const TableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const { openIfAIUnavailable } = useAIKeyGate();
  const tableKey = getWorkspaceTableKey({ workspaceId, viewId: view.id });

  useMountEffect(() => {
    openIfAIUnavailable();
  });

  if (
    view.layout.groupByPropertyId &&
    !includesListItems(view.layout.filters)
  ) {
    return (
      <GroupedTableLayout
        key={tableKey}
        view={view}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <FlatTableLayout key={tableKey} view={view} workspaceId={workspaceId} />
  );
};

const FlatTableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const t = useTranslations();
  const tableState = useTableState({ workspaceId, view });
  const updateView = useUpdateView(workspaceId);
  const showListItems = includesListItems(view.layout.filters);
  const excludedKinds: EntityKind[] = showListItems
    ? ["folder"]
    : ["folder", "task"];

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
        excludedKinds,
        fieldMode: "visible",
        fieldIds,
      }),
    );

  const treeData = useMemo(
    () =>
      toTableEntities(
        data.pages.flatMap((window) =>
          window.entities.filter(
            (entity) =>
              entity.kind !== "folder" &&
              (showListItems || entity.kind !== "task"),
          ),
        ),
      ),
    [data.pages, showListItems],
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
  useSyncSelectedEntities({ viewId: view.id, treeData });
  const tableKey = getWorkspaceTableKey({ workspaceId, viewId: view.id });

  const table = useTable({
    key: tableKey,
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
    <MobileTableOrientationGate>
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
      {TableDevtoolsGate ? (
        <Suspense fallback={null}>
          <TableDevtoolsGate table={table} />
        </Suspense>
      ) : null}
    </MobileTableOrientationGate>
  );
};
