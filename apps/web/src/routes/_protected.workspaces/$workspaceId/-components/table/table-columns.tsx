import { useMemo } from "react";

import {
  CalendarIcon,
  CircleDotIcon,
  ClockIcon,
  FlagIcon,
  HashIcon,
  ShapesIcon,
  TextIcon,
  UserIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { MetadataPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-popover";
import type { SortHint } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/sort-property";
import { getPropertyColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table-column";
import type {
  TableCellContext,
  TableColumnDef,
  TableHeaderContext,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  isListItemType,
  isTaskPriority,
  isTaskStatus,
  ITEM_TYPE_TRANSLATION_KEYS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import {
  getInternalColId,
  getInternalPropertyId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const ADD_PROPERTY_COLUMN_SIZE = 48;
const listNameColId = getInternalPropertyId("name");
const listItemTypeColId = getInternalPropertyId("list-item-type");
const listStatusColId = getInternalPropertyId("status");
const listPriorityColId = getInternalPropertyId("priority");
const listDueDateColId = getInternalPropertyId("due-date");

export const DEFAULT_TABLE_COLUMN_MIN_SIZE = 64;

type UseTableColumnsOptions = {
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
};

/**
 * Shared column definitions for the flat table and every grouped
 * section, so grouped sections render the exact same columns and cells.
 */
export const useTableColumns = ({
  properties,
  view,
}: UseTableColumnsOptions): TableColumnDef[] => {
  const t = useTranslations();
  const format = useFormatter();

  return useMemo(() => {
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

    if (includesListItems(view.layout.filters)) {
      columnDefs.push(
        {
          id: listNameColId,
          accessorFn: (row) => row.name,
          header: createMetadataHeader({
            icon: TextIcon,
            label: t("common.name"),
            sortHint: "text",
          }),
          cell: ({ row }) => (
            <span className="truncate font-medium" dir="auto">
              {row.original.name}
            </span>
          ),
          size: 260,
        },
        {
          id: listItemTypeColId,
          accessorFn: (row) => row.listItemType,
          enableSorting: false,
          header: createMetadataHeader({
            icon: ShapesIcon,
            label: t("common.type"),
            sortHint: "text",
          }),
          cell: ({ row }) => {
            const itemType = isListItemType(row.original.listItemType)
              ? row.original.listItemType
              : "task";
            return t(ITEM_TYPE_TRANSLATION_KEYS[itemType]);
          },
          size: 140,
        },
        {
          id: listStatusColId,
          accessorFn: (row) => row.status,
          header: createMetadataHeader({
            icon: CircleDotIcon,
            label: t("tasks.status"),
            sortHint: "text",
          }),
          cell: ({ row }) =>
            isTaskStatus(row.original.status)
              ? t(`tasks.statusValues.${row.original.status}`)
              : null,
          size: 140,
        },
        {
          id: listPriorityColId,
          accessorFn: (row) => row.priority,
          header: createMetadataHeader({
            icon: FlagIcon,
            label: t("tasks.priority"),
            sortHint: "text",
          }),
          cell: ({ row }) =>
            isTaskPriority(row.original.priority)
              ? t(`tasks.priorityValues.${row.original.priority}`)
              : null,
          size: 120,
        },
        {
          id: listDueDateColId,
          accessorFn: (row) => row.dueDate,
          header: createMetadataHeader({
            icon: CalendarIcon,
            label: t("tasks.dueDate"),
            sortHint: "date",
          }),
          cell: ({ row }) => {
            if (!row.original.dueDate) {
              return null;
            }
            return format.dateTime(
              new Date(`${row.original.dueDate}T00:00:00Z`),
              {
                year: "numeric",
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              },
            );
          },
          size: 140,
        },
      );
    }

    // A graded playbook position materializes two sibling properties: the ASK
    // (ai-model / manual-input) and its verdict (playbook-verdict, carrying the
    // ASK's id in `askPropertyId`). Pair them so each ASK column renders one
    // compliance-matrix cell and the verdict never gets a column of its own.
    const verdictByAskPropertyId = new Map<string, WorkspaceProperty>();
    for (const property of properties) {
      if (property.tool.type === "playbook-verdict") {
        verdictByAskPropertyId.set(property.tool.askPropertyId, property);
      }
    }

    for (const property of properties) {
      if (property.tool.type === "playbook-verdict") {
        continue;
      }
      const col = getPropertyColumn({
        filters: view.layout.filters,
        property,
        verdictProperty: verdictByAskPropertyId.get(property.id),
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
        label: t("common.version"),
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
  }, [format, properties, t, view.layout.filters]);
};

type MetadataHeaderOptions = {
  icon: LucideIcon;
  label: string;
  sortHint: SortHint;
};

const createMetadataHeader =
  ({ icon, label, sortHint }: MetadataHeaderOptions) =>
  ({ header }: TableHeaderContext) => (
    <MetadataPopover
      column={header.column}
      icon={icon}
      label={label}
      sortHint={sortHint}
    />
  );

const renderAuthorCell = ({ row }: TableCellContext) => (
  <AuthorCell entity={row.original} />
);

const renderLastUpdatedCell = ({ row }: TableCellContext) => (
  <LastUpdatedCell entity={row.original} />
);

const renderVersionCell = ({ row }: TableCellContext) => (
  <VersionCell entity={row.original} />
);
