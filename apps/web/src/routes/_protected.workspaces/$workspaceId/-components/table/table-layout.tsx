import { useEffect, useMemo } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ClockIcon, HashIcon, TableIcon, UserIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useAIKeyGate } from "@/components/require-ai-key";
import type { WorkspaceView } from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { MetadataPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-popover";
import { getPropertyColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table-column";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import { useSyncJustificationChunks } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import {
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
const ADD_PROPERTY_COLUMN_SIZE = 40;

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
        limit: 200,
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
      const col = getPropertyColumn(property);
      columnDefs.push(col);
    }

    columnDefs.push({
      id: getInternalPropertyId("created-by"),
      accessorKey: getInternalPropertyId("created-by"),
      meta: { muted: true },
      header: (ctx) => (
        <MetadataPopover
          column={ctx.header.column}
          icon={UserIcon}
          label={t("workspaces.filesystem.author")}
          sortHint="text"
        />
      ),
      cell: (props) => <AuthorCell entity={props.row.original} />,
      size: 160,
    });

    columnDefs.push({
      id: getInternalPropertyId("updated-at"),
      accessorKey: getInternalPropertyId("updated-at"),
      meta: { muted: true },
      header: (ctx) => (
        <MetadataPopover
          column={ctx.header.column}
          icon={ClockIcon}
          label={t("workspaces.filesystem.lastUpdated")}
          sortHint="date"
        />
      ),
      cell: (props) => <LastUpdatedCell entity={props.row.original} />,
      size: 140,
    });

    columnDefs.push({
      id: getInternalPropertyId("version"),
      accessorKey: getInternalPropertyId("version"),
      meta: { muted: true },
      header: (ctx) => (
        <MetadataPopover
          column={ctx.header.column}
          icon={HashIcon}
          label={t("workspaces.filesystem.version")}
          sortHint="number"
        />
      ),
      cell: (props) => <VersionCell entity={props.row.original} />,
      size: 80,
    });

    columnDefs.push({
      id: addPropertyColId,
      accessorKey: addPropertyColId,
      header: () => (
        <CreateProperty triggerVariant="icon" workspaceId={workspaceId} />
      ),
      cell: () => null,
      enableResizing: false,
      enablePinning: false,
      enableSorting: false,
      enableHiding: false,
      minSize: ADD_PROPERTY_COLUMN_SIZE,
      size: ADD_PROPERTY_COLUMN_SIZE,
    });

    return columnDefs;
  }, [properties, workspaceId, t]);

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
      workspaceId={workspaceId}
    />
  );
};
