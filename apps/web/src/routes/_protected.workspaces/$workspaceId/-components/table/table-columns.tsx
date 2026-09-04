import { useMemo } from "react";

import { panic } from "better-result";
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

import type { SortHint } from "@/components/workspaces/properties/sort-property";
import type {
  TableCellContext,
  TableColumnDef,
  TableHeaderContext,
} from "@/components/workspaces/table/types";
import {
  isListItemType,
  isTaskPriority,
  isTaskStatus,
  ITEM_TYPE_TRANSLATION_KEYS,
} from "@/components/workspaces/tasks/task-detail-constants";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { MetadataPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-popover";
import { getPropertyColumnRender } from "@/routes/_protected.workspaces/$workspaceId/-components/table-column";
import type {
  WorkspaceColumnDescriptor,
  WorkspaceColumnRender,
  WorkspaceTableSchema,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";
import { workspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";

export { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";

type UseTableColumnsOptions = {
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
};

/**
 * The table's schema, with the column labels resolved for the reader. The flat
 * table and every grouped section read the same one, so a grouped section
 * cannot drift from the flat table's columns.
 */
export const useWorkspaceTableSchema = ({
  properties,
  view,
}: UseTableColumnsOptions): WorkspaceTableSchema => {
  const t = useTranslations();

  return useMemo(
    () =>
      workspaceTableSchema({
        properties,
        view,
        labels: {
          name: t("common.name"),
          itemType: t("common.type"),
          status: t("tasks.status"),
          priority: t("tasks.priority"),
          dueDate: t("tasks.dueDate"),
          author: t("common.author"),
          lastUpdated: t("workspaces.filesystem.lastUpdated"),
          version: t("common.version"),
        },
      }),
    [properties, t, view],
  );
};

/**
 * Shared column definitions for the flat table and every grouped section, so
 * grouped sections render the exact same columns and cells.
 *
 * The column list itself is the schema's; this turns each of its descriptors
 * into the definition the table library wants.
 */
export const useTableColumns = ({
  properties,
  view,
}: UseTableColumnsOptions): TableColumnDef[] => {
  const schema = useWorkspaceTableSchema({ properties, view });
  const toColumnDef = useColumnDefFactory(view);

  return useMemo(
    () => schema.columns.map(toColumnDef),
    [schema.columns, toColumnDef],
  );
};

/** The parts of a column definition the schema already decided. */
type ColumnBase = {
  id: string;
  size: number;
  minSize?: number;
  enableSorting: boolean;
  enableHiding: boolean;
  enableResizing: boolean;
  enablePinning: boolean;
  meta?: { muted: boolean };
};

const columnBase = (column: WorkspaceColumnDescriptor): ColumnBase => ({
  id: column.id,
  size: column.size,
  ...(column.minSize === undefined ? {} : { minSize: column.minSize }),
  enableSorting: column.capabilities.sort,
  enableHiding: column.capabilities.hide,
  enableResizing: column.capabilities.resize,
  enablePinning: column.capabilities.pin,
  ...(column.emphasis === "metadata" ? { meta: { muted: true } } : {}),
});

type ColumnDefFactory = (column: WorkspaceColumnDescriptor) => TableColumnDef;

const useColumnDefFactory = (
  view: WorkspaceView<"table">,
): ColumnDefFactory => {
  const t = useTranslations();
  const format = useFormatter();

  return useMemo(
    () =>
      (column: WorkspaceColumnDescriptor): TableColumnDef => {
        const base = columnBase(column);
        const metadataHeader = (icon: LucideIcon, sortHint: SortHint) =>
          createMetadataHeader({ icon, label: column.label, sortHint });
        const { render } = column;

        switch (render.type) {
          case "select":
            return { ...base, accessorKey: column.id, header: renderNothing };
          case "add-property":
            return {
              ...base,
              accessorKey: column.id,
              header: renderNothing,
              cell: renderNothing,
            };
          case "name":
            return {
              ...base,
              accessorFn: (row) => row.name,
              header: metadataHeader(TextIcon, "text"),
              cell: ({ row }) => (
                <span className="truncate font-medium" dir="auto">
                  {row.original.name}
                </span>
              ),
            };
          case "list-item-type":
            return {
              ...base,
              accessorFn: (row) => row.listItemType,
              header: metadataHeader(ShapesIcon, "text"),
              cell: ({ row }) => {
                const itemType = isListItemType(row.original.listItemType)
                  ? row.original.listItemType
                  : "task";
                return t(ITEM_TYPE_TRANSLATION_KEYS[itemType]);
              },
            };
          case "task-status":
            return {
              ...base,
              accessorFn: (row) => row.status,
              header: metadataHeader(CircleDotIcon, "text"),
              cell: ({ row }) =>
                isTaskStatus(row.original.status)
                  ? t(`tasks.statusValues.${row.original.status}`)
                  : null,
            };
          case "task-priority":
            return {
              ...base,
              accessorFn: (row) => row.priority,
              header: metadataHeader(FlagIcon, "text"),
              cell: ({ row }) =>
                isTaskPriority(row.original.priority)
                  ? t(`tasks.priorityValues.${row.original.priority}`)
                  : null,
            };
          case "task-due-date":
            return {
              ...base,
              accessorFn: (row) => row.dueDate,
              header: metadataHeader(CalendarIcon, "date"),
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
            };
          case "created-by":
            return {
              ...base,
              accessorKey: column.id,
              header: metadataHeader(UserIcon, "text"),
              cell: renderAuthorCell,
            };
          case "updated-at":
            return {
              ...base,
              accessorKey: column.id,
              header: metadataHeader(ClockIcon, "date"),
              cell: renderLastUpdatedCell,
            };
          case "version":
            return {
              ...base,
              accessorKey: column.id,
              header: metadataHeader(HashIcon, "number"),
              cell: renderVersionCell,
            };
          case "property":
            return {
              ...base,
              ...getPropertyColumnRender({
                filters: view.layout.filters,
                property: render.property,
                verdictProperty: render.verdictProperty,
              }),
            };
          default: {
            render satisfies never;
            return panic(`Unhandled render: ${String(render)}`);
          }
        }
      },
    [format, t, view.layout.filters],
  );
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

const renderNothing = () => null;

const renderAuthorCell = ({ row }: TableCellContext) => (
  <AuthorCell entity={row.original} />
);

const renderLastUpdatedCell = ({ row }: TableCellContext) => (
  <LastUpdatedCell entity={row.original} />
);

const renderVersionCell = ({ row }: TableCellContext) => (
  <VersionCell entity={row.original} />
);

export type { WorkspaceColumnRender };
