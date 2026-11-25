import type { ReactNode } from "react";

import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { WORKSPACE_STATUS } from "@stll/api-contract/workspace-status";
import { Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ContextMenuSurface } from "@stll/ui/entity-actions";
import { ChevronRightIcon } from "@stll/ui/icons";
import { getInitials } from "@stll/ui/initials";
import { getMatterColor } from "@stll/ui/matter-colors";
import { SortableHead, TableCell, TableHead, TableRow } from "@stll/ui/table";
import { HEAD_CONTENT_CLASS } from "@stll/ui/table-shell";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { InlineEdit } from "@/components/inline-edit";
import { Timestamp } from "@/components/timestamp";
import Tooltip from "@/components/tooltip";
import { useMatterContextMenu } from "@/components/workspaces/matter-context-menu";
import { TeamAvatars } from "@/features/workspaces/team-avatars";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { formatFullTimestamp } from "@/lib/relative-time";
import type { Workspace, WorkspaceGroup } from "@/lib/workspaces/types";
import { isFilterableColumnId } from "@/lib/workspaces/types";
import {
  MattersTableShell,
  visibleMattersTableColumns,
} from "@/routes/_protected.workspaces/-components/matters-table.pending";
import type {
  MattersTableColumnEntry,
  MattersTableColumnId,
} from "@/routes/_protected.workspaces/-components/matters-table.pending";
import { ColumnFilterButton } from "@/routes/_protected.workspaces/-filters/column-filter-button";
import { useColumnLabels } from "@/routes/_protected.workspaces/-hooks/use-column-labels";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import { useConfigStore } from "@/stores/config-store";

const MAX_VISIBLE_AVATARS = 3;
const MATTER_INLINE_EDIT_SELECTOR = "[data-matter-inline-edit]";

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
  const columns = visibleMattersTableColumns(hiddenColumns).map((column) => ({
    ...column,
    Cell: MATTERS_TABLE_CELLS[column.id],
  }));

  const filterTrigger = (id: ColumnDef["id"]) => {
    if (!isFilterableColumnId(id)) {
      return null;
    }
    return <ColumnFilterButton columnId={id} workspaces={allWorkspaces} />;
  };

  return (
    <MattersTableShell
      columns={columns}
      header={columns.map((col) => {
        const trailing = filterTrigger(col.id);
        if (col.sortKey === null) {
          return (
            <TableHead className="group/header" key={col.id}>
              <span className={HEAD_CONTENT_CLASS}>
                <TruncatedText>{columnLabels[col.id]}</TruncatedText>
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
    >
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
    </MattersTableShell>
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
    <TruncatedText
      className="font-medium whitespace-pre"
      render={<BidiText as="span" />}
    >
      {workspace.name}
    </TruncatedText>
  </div>
);

const ClientCell = ({ workspace }: CellProps) => {
  const t = useTranslations();
  if (!workspace.client) {
    return (
      <TruncatedText className="text-muted-foreground italic">
        {t("workspaces.parties.personalLabel")}
      </TruncatedText>
    );
  }
  return (
    <TruncatedText
      className="text-muted-foreground"
      render={<BidiText as="span" />}
    >
      {workspace.client.displayName}
    </TruncatedText>
  );
};

const ReferenceCell = ({ workspace }: CellProps) => (
  <TruncatedText className="text-muted-foreground font-mono">
    {workspace.reference}
  </TruncatedText>
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
  <Timestamp
    className="text-muted-foreground"
    format="relative"
    value={workspace.lastActivityAt}
  />
);

const TeamCell = ({ workspace }: CellProps) => (
  <div className="flex min-w-0 justify-end sm:justify-start">
    <TeamAvatars
      leadUserId={workspace.leadUserId}
      maxVisible={MAX_VISIBLE_AVATARS}
      members={workspace.members}
      size="size-5 sm:size-6"
      textSize="text-[0.55rem] sm:text-3xs"
    />
  </div>
);

const CreatedAtCell = ({ workspace }: CellProps) => {
  const date = Temporal.Instant.fromEpochMilliseconds(
    new Date(workspace.createdAt).getTime(),
  )
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDate();
  return (
    <Tooltip
      content={formatFullTimestamp(workspace.createdAt)}
      render={<span className="text-muted-foreground tabular-nums" />}
    >
      {date.toString()}
    </Tooltip>
  );
};

type ColumnDef = MattersTableColumnEntry & {
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
    isArchived: workspace.status === WORKSPACE_STATUS.archived,
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
      "matters-table.navigate",
    );
  };

  return (
    <ContextMenuSurface
      onOpenContextMenu={ctx.onOpenContextMenu}
      preserveNativeTargets={false}
      render={
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
        />
      }
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
                className="font-medium"
                maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
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
    </ContextMenuSurface>
  );
};

/** What each column's cell draws for a matter. */
const MATTERS_TABLE_CELLS = {
  name: NameCell,
  client: ClientCell,
  team: TeamCell,
  reference: ReferenceCell,
  entityCount: EntityCountCell,
  lastActivityAt: LastActivityCell,
  createdAt: CreatedAtCell,
} as const satisfies Record<
  MattersTableColumnId,
  (props: CellProps) => ReactNode
>;

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
                  "text-3xs items-center justify-center rounded-full",
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
                "text-muted-foreground text-3xs tabular-nums",
              )}
            >
              {format.number(group.workspaces.length)}
            </span>
            {group.type === "client" && group.responsibleAttorneyName && (
              <TruncatedText className="text-muted-foreground ms-auto text-xs font-normal">
                {group.responsibleAttorneyName}
              </TruncatedText>
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
