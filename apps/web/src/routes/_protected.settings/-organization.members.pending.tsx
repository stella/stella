import type { ReactElement, ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { InputFace } from "@stll/ui/control-face";
import { CircleHelpIcon, SearchIcon } from "@stll/ui/icons";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";
import { Skeleton } from "@stll/ui/skeleton";
import {
  SortableHeadFace,
  Table,
  TableBody,
  TableCellFace,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { InviteMemberTriggerFace } from "@/components/organization/invite-member-trigger.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { PendingInvitations } from "@/routes/_protected.settings/organization/-components/members-invitations.pending";

export type SortKey = "name" | "role" | "joined";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

type MemberColumnLabel =
  | "common.user"
  | "common.role"
  | "organization.members.billingAccess"
  | "organization.members.joined";

type MemberColumn = {
  id: string;
  className?: string;
} & (
  | {
      sortKey: SortKey;
      label: MemberColumnLabel;
      labelWidth: string;
    }
  | {
      sortKey?: undefined;
      label: MemberColumnLabel;
      labelWidth: string;
    }
  | { sortKey?: undefined; label?: undefined; labelWidth?: undefined }
);

const MEMBER_COLUMNS = [
  { id: "user", sortKey: "name", label: "common.user", labelWidth: "w-10" },
  { id: "role", sortKey: "role", label: "common.role", labelWidth: "w-10" },
  {
    id: "billing",
    label: "organization.members.billingAccess",
    labelWidth: "w-24",
    className: "hidden sm:table-cell",
  },
  {
    id: "joined",
    sortKey: "joined",
    label: "organization.members.joined",
    labelWidth: "w-14",
    className: "hidden sm:table-cell",
  },
  { id: "actions", className: "w-12" },
] as const satisfies readonly MemberColumn[];

type MemberColumnId = (typeof MEMBER_COLUMNS)[number]["id"];

export const INITIAL_MEMBERS_SORT: Sort = { key: "name", dir: "asc" };

export const MemberRowCells = ({
  cells,
}: {
  cells: Record<MemberColumnId, ReactNode>;
}) => (
  <>
    {MEMBER_COLUMNS.map((column) => (
      <TableCellFace
        align={column.id === "actions" ? "end" : undefined}
        className={cn("className" in column && column.className)}
        key={column.id}
        numeric={column.id === "joined"}
        tone={column.id === "joined" ? "muted" : undefined}
      >
        {cells[column.id]}
      </TableCellFace>
    ))}
  </>
);

/** Spanned by the row that replaces members when none match. */
export const MEMBER_COLUMN_COUNT = MEMBER_COLUMNS.length;

type MembersSortFaceOptions = {
  className: string | undefined;
  label: ReactNode;
  sortKey: SortKey;
};

const MembersTableHeader = ({
  billingHeaderHelp,
  renderSortableHead,
}: {
  billingHeaderHelp?: ReactNode;
  renderSortableHead?:
    ((options: MembersSortFaceOptions) => ReactElement) | undefined;
}) => (
  <TableHeader>
    <TableRow>
      {MEMBER_COLUMNS.map((column) => {
        const className = cn("className" in column && column.className);
        if (!("label" in column)) {
          return <TableHead className={className} key={column.id} />;
        }
        const text = (
          <PendingText id={column.label} barClassName={column.labelWidth} />
        );
        if (!("sortKey" in column)) {
          return (
            <TableHead className={className} key={column.id}>
              <span className="inline-flex items-center gap-1">
                {text}
                {column.id === "billing"
                  ? (billingHeaderHelp ?? (
                      <CircleHelpIcon
                        aria-hidden="true"
                        className="text-muted-foreground size-3.5"
                      />
                    ))
                  : null}
              </span>
            </TableHead>
          );
        }
        const { id, sortKey } = column;
        return renderSortableHead === undefined ? (
          <SortableHeadFace
            className={className}
            key={id}
            sortDirection={
              sortKey === INITIAL_MEMBERS_SORT.key
                ? INITIAL_MEMBERS_SORT.dir
                : null
            }
          >
            {text}
          </SortableHeadFace>
        ) : (
          renderSortableHead({ className, label: text, sortKey })
        );
      })}
    </TableRow>
  </TableHeader>
);

/** Shared frame and controls of the members toolbar. */
export const MembersToolbarFace = ({
  search,
  invite,
}: {
  search: ReactNode;
  invite: ReactNode;
}) => (
  <div className="border-border/60 flex items-center justify-between gap-3 border-b px-3 py-2.5">
    <div className="flex max-w-sm min-w-0 flex-1">{search}</div>
    {invite}
  </div>
);

/** The active members table and invitations share this frame in either phase. */
export const MembersShell = ({
  billingHeaderHelp,
  busy,
  toolbar,
  renderSortableHead,
  children,
  invitations,
}: {
  billingHeaderHelp?: ReactNode;
  busy?: boolean;
  toolbar: ReactNode;
  renderSortableHead?:
    ((options: MembersSortFaceOptions) => ReactElement) | undefined;
  children: ReactNode;
  invitations: ReactNode;
}) => (
  <>
    <SettingsPageHeader
      description={
        <PendingText
          id="settings.organization.membersDescription"
          barClassName="w-64 max-w-full"
        />
      }
      title={<PendingText id="common.members" barClassName="w-20" />}
    />
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
        <PendingText
          id="settings.organization.activeMembers"
          barClassName="w-24"
        />
      </h2>
      <SettingsSection>
        <SettingsPanel inset="flush">
          {toolbar}
          <Table aria-busy={renderSortableHead === undefined || undefined}>
            <MembersTableHeader
              billingHeaderHelp={billingHeaderHelp}
              renderSortableHead={renderSortableHead}
            />
            <TableBody aria-busy={busy}>{children}</TableBody>
          </Table>
        </SettingsPanel>
      </SettingsSection>
    </section>
    {invitations}
  </>
);

const MEMBER_PLACEHOLDERS = {
  user: (
    <div className="flex items-center gap-2">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex flex-col">
        <div className="flex h-5 items-center">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex h-4 items-center">
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    </div>
  ),
  role: <Skeleton className="h-8 w-36" />,
  billing: <Skeleton className="h-4.5 w-7.5 rounded-full" />,
  joined: <Skeleton className="h-4 w-24" />,
  actions: null,
} satisfies Record<MemberColumnId, ReactNode>;

const MEMBER_SKELETON_COLUMNS = MEMBER_COLUMNS.map((column) => ({
  id: column.id,
  className: "className" in column ? column.className : undefined,
  placeholder: MEMBER_PLACEHOLDERS[column.id],
}));
const MEMBERS_SKELETON_ROW_COUNT = 8;

export const MembersPending = framePendingView(() => {
  const q = useSearch({
    strict: false,
    select: (search) => (typeof search.q === "string" ? search.q : undefined),
  });
  return (
    <SettingsPagePending area="organization">
      <MembersShell
        busy
        invitations={<PendingInvitations />}
        toolbar={
          <MembersToolbarFace
            invite={<InviteMemberTriggerFace />}
            search={
              <InputFace icon={<SearchIcon />}>
                {q ?? <PendingText id="common.search" barClassName="w-14" />}
              </InputFace>
            }
          />
        }
      >
        <TableSkeletonRows
          columns={MEMBER_SKELETON_COLUMNS}
          count={MEMBERS_SKELETON_ROW_COUNT}
        />
      </MembersShell>
    </SettingsPagePending>
  );
});
