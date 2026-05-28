import { useEffect, useMemo } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import type { CellContext, HeaderContext } from "@tanstack/react-table";
import { ClockIcon, HashIcon, TableIcon, UserIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useAIKeyGate } from "@/components/require-ai-key";
import type { WorkspaceView } from "@/lib/types";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { MetadataPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-popover";
import type { SortHint } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import { getPropertyColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table-column";
import type {
  TableColumnDef,
  TableTreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import { useSyncJustificationChunks } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  useEntitiesWindowOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import {
  getInternalColId,
  getInternalPropertyId,
  toTableEntities,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const DEFAULT_COLUMN_MIN_SIZE = 64;
const ADD_PROPERTY_COLUMN_SIZE = 48;

type MetadataHeaderOptions = {
  icon: LucideIcon;
  label: string;
  sortHint: SortHint;
};

const createMetadataHeader =
  ({ icon, label, sortHint }: MetadataHeaderOptions) =>
  ({ header }: HeaderContext<TableTreeNode, unknown>) => (
    <MetadataPopover
      column={header.column}
      icon={icon}
      label={label}
      sortHint={sortHint}
    />
  );

const renderAuthorCell = ({ row }: CellContext<TableTreeNode, unknown>) => (
  <AuthorCell entity={row.original} />
);

const renderLastUpdatedCell = ({
  row,
}: CellContext<TableTreeNode, unknown>) => (
  <LastUpdatedCell entity={row.original} />
);

const renderVersionCell = ({ row }: CellContext<TableTreeNode, unknown>) => (
  <VersionCell entity={row.original} />
);

type TableLayoutProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const TableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const t = useTranslations();
  const { openIfAIUnavailable } = useAIKeyGate();
  const tableState = useTableState({ workspaceId, view });

  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const fieldIds = useMemo(
    () =>
      visibleEntityFieldIds({
        hiddenProperties: view.layout.hiddenProperties,
        properties,
      }),
    [properties, view.layout.hiddenProperties],
  );

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

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

  const columns = useMemo(() => {
    const columnDefs: TableColumnDef[] = [
      {
        id: selectColId,
        accessorKey: selectColId,
        header: () => null,
        enableResizing: false,
        enableSorting: false,
        enableHiding: false,
        minSize: 48,
        size: 48,
      },
    ];

    for (const property of properties) {
      const col = getPropertyColumn({
        filters: view.layout.filters,
        property,
      });
      columnDefs.push(col);
    }

    columnDefs.push({
      id: getInternalPropertyId("created-by"),
      accessorKey: getInternalPropertyId("created-by"),
      meta: { muted: true },
      header: createMetadataHeader({
        icon: UserIcon,
        label: t("workspaces.filesystem.author"),
        sortHint: "text",
      }),
      cell: renderAuthorCell,
      size: 160,
    });

    columnDefs.push({
      id: getInternalPropertyId("updated-at"),
      accessorKey: getInternalPropertyId("updated-at"),
      meta: { muted: true },
      header: createMetadataHeader({
        icon: ClockIcon,
        label: t("workspaces.filesystem.lastUpdated"),
        sortHint: "date",
      }),
      cell: renderLastUpdatedCell,
      size: 140,
    });

    columnDefs.push({
      id: getInternalPropertyId("version"),
      accessorKey: getInternalPropertyId("version"),
      meta: { muted: true },
      header: createMetadataHeader({
        icon: HashIcon,
        label: t("workspaces.filesystem.version"),
        sortHint: "number",
      }),
      cell: renderVersionCell,
      size: 80,
    });

    columnDefs.push({
      id: addPropertyColId,
      accessorKey: addPropertyColId,
      header: () => null,
      cell: () => null,
      enableResizing: false,
      enablePinning: false,
      enableSorting: false,
      enableHiding: false,
      minSize: ADD_PROPERTY_COLUMN_SIZE,
      size: ADD_PROPERTY_COLUMN_SIZE,
    });

    return columnDefs;
  }, [properties, t, view.layout.filters]);

  const table = useReactTable({
    columnResizeMode: "onChange",
    data: treeData,
    columns,
    defaultColumn: {
      minSize: DEFAULT_COLUMN_MIN_SIZE,
    },
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
    ...tableState.listeners,
  });

  if (table.getRowModel().rows.length === 0) {
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.noItems")}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <WorkspaceTable
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={() => {
        // eslint-disable-next-line typescript/no-floating-promises
        fetchNextPage();
      }}
      table={table}
      contentMode={tableState.contentMode}
      workspaceId={workspaceId}
    />
  );
};
