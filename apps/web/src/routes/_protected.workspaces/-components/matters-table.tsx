import type { ReactNode } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { BidiText } from "@stll/ui/components/bidi-text";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Frame } from "@stll/ui/components/frame";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { detached } from "@/lib/detached";
import { getMatterColor } from "@/lib/matter-colors";
import { formatRelativeTime } from "@/lib/relative-time";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useMatterContextMenu } from "@/routes/_protected.workspaces/-components/matter-context-menu";
import {
  getInitials,
  TeamAvatars,
} from "@/routes/_protected.workspaces/-components/team-avatars";
import { ColumnFilterButton } from "@/routes/_protected.workspaces/-filters/column-filter-button";
import { useColumnLabels } from "@/routes/_protected.workspaces/-hooks/use-column-labels";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import type {
  MattersColumnId,
  MattersSortKey,
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";
import {
  ALL_COLUMNS,
  isFilterableColumnId,
} from "@/routes/_protected.workspaces/-types";
import { useConfigStore } from "@/stores/config-store";

const MAX_VISIBLE_AVATARS = 3;
const MATTER_INLINE_EDIT_SELECTOR = "[data-matter-inline-edit]";
const MATTERS_TABLE_NAME_COLUMN_WIDTH_PX = 260;

const isInlineEditEvent = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(MATTER_INLINE_EDIT_SELECTOR) !== null;

type MattersTableProps = {
  workspaces: Workspace[];
  /** Full pre-filter pool used to populate filter option lists. */
  allWorkspaces: readonly Workspace[];
  groups: WorkspaceGroup[] | null;
  focusIndex: number;
  collapsedGroups: string[];
  onToggleGroup: (groupId: string) => void;
};

export const MattersTable = ({
  workspaces,
  allWorkspaces,
  groups,
  focusIndex,
  collapsedGroups,
  onToggleGroup,
}: MattersTableProps) => {
  const update = useConfigStore((s) => s.updateMatters);

  const { sortKey, sortDesc, hiddenColumns } = useConfigStore(
    useShallow((s) => ({
      sortKey: s.matters.sortKey,
      sortDesc: s.matters.sortDesc,
      hiddenColumns: s.matters.hiddenColumns,
    })),
  );

  const sortLabels = useSortLabels();
  const columnLabels = useColumnLabels();
  const hiddenColumnSet = new Set(hiddenColumns);
  // Name is always rendered; user-toggleable columns come from ALL_COLUMNS.
  const visibleColumnSet = new Set(
    ALL_COLUMNS.filter((c) => !hiddenColumnSet.has(c)),
  );
  const columns = COLUMNS.filter((col) =>
    col.id === "name" ? true : visibleColumnSet.has(col.id),
  );
  const minTableWidth = columns.reduce(
    (sum, column) => sum + column.widthPx,
    0,
  );

  const filterTrigger = (id: ColumnDef["id"]) => {
    if (!isFilterableColumnId(id)) {
      return null;
    }
    return <ColumnFilterButton columnId={id} workspaces={allWorkspaces} />;
  };

  return (
    <Frame className="overflow-hidden rounded-lg sm:rounded-2xl">
      <div className="overflow-x-auto">
        <Table
          className="table-fixed"
          style={{ minWidth: `${minTableWidth}px` }}
        >
          <colgroup>
            {columns.map((col) => (
              <col key={col.id} style={{ width: `${col.widthPx}px` }} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>
              {columns.map((col) => {
                const trailing = filterTrigger(col.id);
                if (col.type === "static") {
                  return (
                    <TableHead className="group/header" key={col.id}>
                      <span className="inline-flex items-center gap-1">
                        <span className="truncate">{columnLabels[col.id]}</span>
                        {trailing}
                      </span>
                    </TableHead>
                  );
                }
                const key = col.sortKey;
                const direction: "asc" | "desc" | null = (() => {
                  if (sortKey !== key) {
                    return null;
                  }
                  return sortDesc ? "desc" : "asc";
                })();
                return (
                  <SortableHead
                    className="group/header"
                    key={col.id}
                    onSort={() => {
                      if (sortKey === key) {
                        update({ sortDesc: !sortDesc });
                      } else {
                        update({ sortKey: key, sortDesc: true });
                      }
                    }}
                    sortDirection={direction}
                    trailing={trailing}
                  >
                    {sortLabels[key]}
                  </SortableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups && groups.length > 0
              ? groups.map((group) => (
                  <MattersTableGroup
                    collapsed={collapsedGroups.includes(group.groupId)}
                    columns={columns}
                    focusIndex={focusIndex}
                    group={group}
                    key={group.groupId}
                    onToggle={() => onToggleGroup(group.groupId)}
                    workspaces={workspaces}
                  />
                ))
              : workspaces.map((ws, i) => (
                  <MattersTableRow
                    columns={columns}
                    focusIndex={focusIndex}
                    globalIndex={i}
                    key={ws.id}
                    workspace={ws}
                  />
                ))}
          </TableBody>
        </Table>
      </div>
    </Frame>
  );
};

type CellProps = { workspace: Workspace };

const NameCell = ({ workspace }: CellProps) => (
  <div className="flex min-w-0 items-center gap-2">
    <span
      className="size-2 shrink-0 rounded-full"
      style={{
        backgroundColor: getMatterColor(workspace.id),
      }}
    />
    <BidiText as="span" className="truncate font-medium">
      {workspace.name}
    </BidiText>
  </div>
);

const ClientCell = ({ workspace }: CellProps) => {
  const t = useTranslations();
  if (!workspace.client) {
    return (
      <span className="text-muted-foreground block truncate italic">
        {t("workspaces.parties.personalLabel")}
      </span>
    );
  }
  return (
    <BidiText as="span" className="text-muted-foreground block truncate">
      {workspace.client.displayName}
    </BidiText>
  );
};

const ReferenceCell = ({ workspace }: CellProps) => (
  <span className="text-muted-foreground block truncate font-mono">
    {workspace.reference}
  </span>
);

const EntityCountCell = ({ workspace }: CellProps) => {
  const format = useFormatter();
  return (
    <span className="text-muted-foreground tabular-nums">
      {format.number(workspace.entityCount)}
    </span>
  );
};

const LastActivityCell = ({ workspace }: CellProps) => (
  <Tooltip
    content={new Date(workspace.lastActivityAt).toLocaleString(
      getFormattingLocale(),
      {
        dateStyle: "full",
        timeStyle: "medium",
      },
    )}
    render={<span className="text-muted-foreground" />}
  >
    {formatRelativeTime(workspace.lastActivityAt)}
  </Tooltip>
);

/** Format a Date as `YYYY-MM-DD` in local time (locale-neutral, ISO-style). */
const toLocalISODate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const TeamCell = ({ workspace }: CellProps) => (
  <div className="flex min-w-0 justify-end sm:justify-start">
    <TeamAvatars
      leadUserId={workspace.leadUserId}
      maxVisible={MAX_VISIBLE_AVATARS}
      members={workspace.members}
      size="size-5 sm:size-6"
      textSize="text-[0.55rem] sm:text-[0.625rem]"
    />
  </div>
);

const CreatedAtCell = ({ workspace }: CellProps) => {
  const date = new Date(workspace.createdAt);
  return (
    <Tooltip
      content={date.toLocaleString(getFormattingLocale(), {
        dateStyle: "full",
        timeStyle: "medium",
      })}
      render={<span className="text-muted-foreground tabular-nums" />}
    >
      {toLocalISODate(date)}
    </Tooltip>
  );
};

type ColumnDef =
  | {
      type: "sortable";
      id: MattersColumnId | "name";
      sortKey: MattersSortKey;
      widthPx: number;
      Cell: (props: CellProps) => ReactNode;
    }
  | {
      type: "static";
      id: MattersColumnId;
      widthPx: number;
      Cell: (props: CellProps) => ReactNode;
    };

type MattersTableRowProps = {
  workspace: Workspace;
  globalIndex: number;
  columns: readonly ColumnDef[];
  focusIndex: number;
};

const MattersTableRow = ({
  workspace,
  globalIndex,
  columns,
  focusIndex,
}: MattersTableRowProps) => {
  const navigate = useNavigate();
  const ctx = useMatterContextMenu({
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    client: workspace.client,
  });
  const isEditing = ctx.rename.status === "editing";

  const openMatter = () => {
    if (isEditing) {
      return;
    }
    detached(
      navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      }),
      "openMatter",
    );
  };

  return (
    <TableRow
      className={cn(
        "hover:bg-accent/30 cursor-pointer outline-none",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        focusIndex === globalIndex && "bg-accent/50",
      )}
      onClick={(event) => {
        if (isInlineEditEvent(event.target)) {
          return;
        }
        openMatter();
      }}
      onContextMenu={ctx.onContextMenu}
      onKeyDown={(event) => {
        if (isInlineEditEvent(event.target)) {
          return;
        }
        if (!isEditing && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openMatter();
        }
      }}
      tabIndex={0}
    >
      {columns.map((col, i) => (
        <TableCell key={col.id}>
          {col.id === "name" && ctx.rename.status === "editing" ? (
            <div
              data-matter-inline-edit
              className="flex min-w-0 items-center gap-2"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: getMatterColor(workspace.id) }}
              />
              <InlineEdit
                onCancel={ctx.rename.cancel}
                onChange={ctx.rename.setDraft}
                onCommit={ctx.rename.commit}
                value={ctx.rename.draft}
              />
            </div>
          ) : (
            <col.Cell workspace={workspace} />
          )}
          {/* Menu + dialogs live inside a cell so the trigger span stays
              valid inside the row; the popups portal out regardless. */}
          {i === 0 && (
            <>
              {ctx.menu}
              {ctx.dialogs}
            </>
          )}
        </TableCell>
      ))}
    </TableRow>
  );
};

const COLUMNS = [
  {
    type: "sortable",
    id: "name",
    sortKey: "name",
    widthPx: MATTERS_TABLE_NAME_COLUMN_WIDTH_PX,
    Cell: NameCell,
  },
  {
    type: "sortable",
    id: "client",
    sortKey: "clientName",
    widthPx: 240,
    Cell: ClientCell,
  },
  { type: "static", id: "team", widthPx: 160, Cell: TeamCell },
  {
    type: "sortable",
    id: "reference",
    sortKey: "reference",
    widthPx: 120,
    Cell: ReferenceCell,
  },
  {
    type: "sortable",
    id: "entityCount",
    sortKey: "entityCount",
    widthPx: 96,
    Cell: EntityCountCell,
  },
  {
    type: "sortable",
    id: "lastActivityAt",
    sortKey: "lastActivityAt",
    widthPx: 140,
    Cell: LastActivityCell,
  },
  {
    type: "sortable",
    id: "createdAt",
    sortKey: "createdAt",
    widthPx: 120,
    Cell: CreatedAtCell,
  },
] as const satisfies readonly ColumnDef[];

type MattersTableGroupProps = {
  group: WorkspaceGroup;
  workspaces: Workspace[];
  columns: readonly ColumnDef[];
  focusIndex: number;
  collapsed: boolean;
  onToggle: () => void;
};

const MattersTableGroup = ({
  group,
  workspaces,
  columns,
  focusIndex,
  collapsed,
  onToggle,
}: MattersTableGroupProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const firstWs = group.workspaces.at(0);

  if (!firstWs) {
    return null;
  }

  const baseIndex = workspaces.indexOf(firstWs);

  return (
    <>
      <TableRow
        className="bg-muted/40 hover:bg-muted/60 cursor-pointer"
        data-group-id={group.groupId}
        onClick={onToggle}
      >
        <TableCell
          className="h-11 py-2.5 font-semibold"
          colSpan={columns.length}
        >
          <div className="flex items-center gap-2">
            <DirectionalIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                !collapsed && "rotate-90",
              )}
              flip={collapsed}
              icon={ChevronRightIcon}
            />
            {group.type === "client" && (
              <span
                aria-hidden
                className={cn(
                  "bg-background ring-border flex size-5 shrink-0",
                  "items-center justify-center rounded-full text-[0.625rem]",
                  "font-medium tracking-tight ring-1",
                )}
              >
                {getInitials(group.clientName)}
              </span>
            )}
            {group.type === "personal" ? (
              <span>{t("workspaces.parties.personalLabel")}</span>
            ) : (
              <Link
                className="hover:underline"
                onClick={(e) => e.stopPropagation()}
                params={{ contactId: group.clientId }}
                to="/contacts/$contactId"
              >
                <BidiText>{group.clientName}</BidiText>
              </Link>
            )}
            <span
              className={cn(
                "bg-background ring-border rounded-full px-1.5 py-0.5 ring-1",
                "text-muted-foreground text-[0.625rem] tabular-nums",
              )}
            >
              {format.number(group.workspaces.length)}
            </span>
            {group.type === "client" && group.responsibleAttorneyName && (
              <span className="text-muted-foreground ms-auto truncate text-xs font-normal">
                {group.responsibleAttorneyName}
              </span>
            )}
          </div>
        </TableCell>
      </TableRow>
      {!collapsed &&
        group.workspaces.map((ws, i) => (
          <MattersTableRow
            columns={columns}
            focusIndex={focusIndex}
            globalIndex={baseIndex + i}
            key={ws.id}
            workspace={ws}
          />
        ))}
    </>
  );
};
