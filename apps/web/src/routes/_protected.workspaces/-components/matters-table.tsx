import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";

import { Frame } from "@stella/ui/components/frame";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stella/ui/components/table";
import { cn } from "@stella/ui/lib/utils";

import { useI18nStore } from "@/i18n/i18n-store";
import { getMatterColor } from "@/lib/matter-colors";
import { formatRelativeTime } from "@/lib/relative-time";
import { useSortLabels } from "@/routes/_protected.workspaces/-hooks/use-sort-labels";
import type {
  MattersColumnId,
  MattersSortKey,
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";
import { useConfigStore } from "@/stores/config-store";

const SORT_KEY_TO_COLUMN_ID: Partial<Record<MattersSortKey, MattersColumnId>> =
  {
    clientName: "client",
    reference: "reference",
    entityCount: "entityCount",
    lastActivityAt: "lastActivityAt",
    createdAt: "createdAt",
  };

type MattersTableProps = {
  workspaces: Workspace[];
  groups: WorkspaceGroup[] | null;
  focusIndex: number;
  collapsedGroups: string[];
  onToggleGroup: (groupId: string) => void;
};

export const MattersTable = ({
  workspaces,
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

  const columnLabels = useSortLabels();
  const visibleColumns = ALL_COLUMNS.filter((c) => !hiddenColumns.includes(c));
  const columns = COLUMNS.filter((col) => {
    const colId = SORT_KEY_TO_COLUMN_ID[col.key];
    if (!colId) {
      return true;
    }
    return visibleColumns.includes(colId);
  });

  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <SortableHead
                active={sortKey === col.key}
                desc={sortDesc}
                key={col.key}
                onClick={() => {
                  if (sortKey === col.key) {
                    update({ sortDesc: !sortDesc });
                  } else {
                    update({ sortKey: col.key, sortDesc: true });
                  }
                }}
              >
                {columnLabels[col.key]}
              </SortableHead>
            ))}
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
    </Frame>
  );
};

type CellProps = { workspace: Workspace };

const NameCell = ({ workspace }: CellProps) => (
  <div className="flex items-center gap-2">
    <span
      className="size-2 shrink-0 rounded-full"
      style={{
        backgroundColor: getMatterColor(workspace.id),
      }}
    />
    <span className="font-medium">{workspace.name}</span>
  </div>
);

const ClientCell = ({ workspace }: CellProps) => (
  <span className="text-muted-foreground">
    {workspace.client?.displayName ?? "—"}
  </span>
);

const ReferenceCell = ({ workspace }: CellProps) => (
  <span className="text-muted-foreground font-mono">
    {workspace.reference ?? "—"}
  </span>
);

const EntityCountCell = ({ workspace }: CellProps) => (
  <span className="text-muted-foreground tabular-nums">
    {workspace.entityCount}
  </span>
);

const LastActivityCell = ({ workspace }: CellProps) => {
  const lang = useI18nStore((s) => s.lang);
  return (
    <span
      className="text-muted-foreground"
      title={new Date(workspace.lastActivityAt).toLocaleString(lang, {
        dateStyle: "full",
        timeStyle: "medium",
      })}
    >
      {formatRelativeTime(workspace.lastActivityAt, lang)}
    </span>
  );
};

const CreatedAtCell = ({ workspace }: CellProps) => {
  const lang = useI18nStore((s) => s.lang);
  return (
    <span className="text-muted-foreground">
      {new Date(workspace.createdAt).toLocaleDateString(lang)}
    </span>
  );
};

type ColumnDef = {
  key: MattersSortKey;
  Cell: (props: CellProps) => React.ReactNode;
};

type MattersTableRowProps = {
  workspace: Workspace;
  globalIndex: number;
  columns: ColumnDef[];
  focusIndex: number;
};

const MattersTableRow = ({
  workspace,
  globalIndex,
  columns,
  focusIndex,
}: MattersTableRowProps) => {
  const navigate = useNavigate();

  return (
    <TableRow
      className={cn(
        "cursor-pointer",
        focusIndex === globalIndex && "bg-accent/50",
      )}
      onClick={() => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: workspace.id },
        });
      }}
    >
      {columns.map((col) => (
        <TableCell key={col.key}>
          <col.Cell workspace={workspace} />
        </TableCell>
      ))}
    </TableRow>
  );
};

const COLUMNS: ColumnDef[] = [
  { key: "name", Cell: NameCell },
  { key: "clientName", Cell: ClientCell },
  { key: "reference", Cell: ReferenceCell },
  { key: "entityCount", Cell: EntityCountCell },
  { key: "lastActivityAt", Cell: LastActivityCell },
  { key: "createdAt", Cell: CreatedAtCell },
];

type MattersTableGroupProps = {
  group: WorkspaceGroup;
  workspaces: Workspace[];
  columns: ColumnDef[];
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
  const firstWs = group.workspaces.at(0);

  if (!firstWs) {
    return null;
  }

  const baseIndex = workspaces.indexOf(firstWs);

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="font-semibold" colSpan={columns.length}>
          <span className="inline-flex items-center gap-2">
            <ChevronRightIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                !collapsed && "rotate-90",
              )}
            />
            <Link
              className="hover:underline"
              onClick={(e) => e.stopPropagation()}
              params={{ contactId: group.clientId }}
              to="/contacts/$contactId"
            >
              {group.clientName}
            </Link>
            <span
              className={cn(
                "bg-muted rounded-full px-1.5 py-0.5",
                "text-muted-foreground text-[0.625rem] tabular-nums",
              )}
            >
              {group.workspaces.length}
            </span>
          </span>
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

type SortableHeadProps = React.PropsWithChildren<{
  active: boolean;
  desc: boolean;
  onClick: () => void;
}>;

const SortableHead = ({
  children,
  active,
  desc,
  onClick,
}: SortableHeadProps) => (
  <TableHead>
    <button
      className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 font-medium select-none"
      onClick={onClick}
      type="button"
    >
      {children}
      {active &&
        (desc ? (
          <ArrowDownIcon className="size-3" />
        ) : (
          <ArrowUpIcon className="size-3" />
        ))}
    </button>
  </TableHead>
);
