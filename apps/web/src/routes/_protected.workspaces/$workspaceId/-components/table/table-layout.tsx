import { lazy, Suspense, useDeferredValue, useMemo } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { SearchXIcon, TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { VIEW_SORTS_MAX } from "@stll/api-contract";

import { useAIKeyGate } from "@/components/require-ai-key";
import { toTableEntities } from "@/components/workspaces/entity-utils";
import { useSyncJustificationChunks } from "@/components/workspaces/hooks/use-sync-justifications";
import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import { useEntityTableFind } from "@/components/workspaces/table/use-entity-table-find";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";
import { useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  visibleEntityFieldIds,
} from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { workspaceTableAdapter } from "@/lib/workspaces/table-adapter";
import { mergeLayout } from "@/lib/workspaces/view-layout";
import {
  EmptyState,
  FilteredEmptyState,
} from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useEntityRowHost } from "@/routes/_protected.workspaces/$workspaceId/-components/table/entity-row-host";
import { GroupedTableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout";
import { useTableColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import { useSyncSelectedEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-selected-entities";
import { useViewColumnLayout } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-view-column-layout";
import { useViewTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-view-table-state";

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
  const columnLayout = useViewColumnLayout({ workspaceId, view });
  const tableState = useViewTableState({ workspaceId, view, columnLayout });
  const updateView = useUpdateView(workspaceId);
  const showListItems = includesListItems(view.layout.filters);
  const excludedKinds: EntityKind[] = showListItems
    ? ["folder"]
    : ["folder", "task"];

  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const columns = useTableColumns({ properties, view });
  // Deferred alongside the window key (`useListPage` defers its own), so the
  // marks and the empty state describe the rows on screen, not the term whose
  // fetch is still in flight.
  const find = useDeferredValue(
    useEntityTableFind({
      hasNameColumn: showListItems,
      hiddenProperties: view.layout.hiddenProperties,
      properties,
      view: { workspaceId, viewId: view.id },
    }),
  );
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
      workspaceTableAdapter.useListPage({
        workspaceId,
        filters: view.layout.filters,
        sorts: view.layout.sorts,
        limit: DEFAULT_ENTITY_WINDOW_SIZE,
        excludedKinds,
        fieldMode: "visible",
        fieldIds,
        ...find.request,
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
  useSyncSelectedEntities({ workspaceId, viewId: view.id, treeData });
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
    maxMultiSortColCount: VIEW_SORTS_MAX,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
    ...tableState.listeners,
  });
  const rowHost = useEntityRowHost({ workspaceId, table, addRow: true });

  if (table.getRowModel().rows.length === 0) {
    // Ahead of the filter and upload states: with a find running, "upload your
    // first document" answers a question nobody asked.
    if (find.highlight) {
      return (
        <EmptyState
          hint={t("workspaces.views.noFindResultsHint")}
          icon={SearchXIcon}
          message={t("workspaces.views.noFindResults", {
            term: find.highlight.term,
          })}
        />
      );
    }
    if (view.layout.filters.length > 0) {
      return (
        <FilteredEmptyState
          onClearFilters={() =>
            updateView.mutate({
              viewId: view.id,
              layout: mergeLayout(view.layout, { filters: [] }),
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
      <FindHighlightScope highlight={find.highlight}>
        <WorkspaceTable
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => {
            detached(fetchNextPage(), "table-layout.fetch-next-page");
          }}
          rowHost={rowHost}
          table={table}
          contentMode={tableState.contentMode}
        />
      </FindHighlightScope>
      {TableDevtoolsGate ? (
        <Suspense fallback={null}>
          <TableDevtoolsGate table={table} />
        </Suspense>
      ) : null}
    </MobileTableOrientationGate>
  );
};
