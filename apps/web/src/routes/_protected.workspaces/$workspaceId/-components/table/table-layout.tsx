import { useMemo } from "react";

import { Checkbox } from "@stll/ui/components/checkbox";
import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ClockIcon, HashIcon, TableIcon, UserIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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

type TableLayoutProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const TableLayout = ({ workspaceId, view }: TableLayoutProps) => {
  const t = useTranslations();
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
        header: (props) => (
          <div className="flex items-center justify-center">
            <Checkbox
              checked={props.table.getIsAllRowsSelected()}
              indeterminate={props.table.getIsSomeRowsSelected()}
              onCheckedChange={(checked) =>
                props.table.toggleAllRowsSelected(checked)
              }
            />
          </div>
        ),
        enableResizing: false,
        enableSorting: false,
        enableHiding: false,
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
      header: () => <CreateProperty workspaceId={workspaceId} />,
      enableResizing: false,
      enablePinning: false,
      enableSorting: false,
      enableHiding: false,
      size: 48,
    });

    return columnDefs;
  }, [properties, workspaceId, t]);

  const table = useReactTable({
    columnResizeMode: "onChange",
    data: treeData,
    columns,
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
