import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Frame } from "@stll/ui/frame";
import { SearchIcon } from "@stll/ui/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { Skeleton } from "@stll/ui/skeleton";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import {
  InvitationsSkeletonRows,
  InvitationsTableHeader,
} from "@/routes/_protected.settings/organization/-components/members-invitations.pending";

export type SortKey = "name" | "role" | "joined";
type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

/** Rows held open while the members load. */
const MEMBERS_SKELETON_ROW_COUNT = 8;

// The members and invitations tables are hand-rolled @stll/ui markup (no
// TanStack), so a single column descriptor array per table is the source of
// truth: both the real header and the loading skeleton map over it, so they
// cannot drift. `sortKey` distinguishes sortable heads from inert ones (the
// trailing actions column has no header). `skeleton` shapes the placeholder.
type MemberSkeletonShape = "identity" | "control" | "text" | "none";

// Secondary columns give way on phones, so the columns people act on fit
// without scrolling sideways.
const SECONDARY_COLUMN_CLASS = "hidden sm:table-cell";

type MemberColumn = {
  id: "user" | "role" | "billing" | "joined" | "actions";
  sortKey: SortKey | null;
  label:
    | "common.user"
    | "common.role"
    | "organization.members.joined"
    | "organization.members.billingAccess"
    | null;
  skeleton: MemberSkeletonShape;
  secondary?: true;
};

const MEMBER_COLUMNS: readonly MemberColumn[] = [
  { id: "user", sortKey: "name", label: "common.user", skeleton: "identity" },
  { id: "role", sortKey: "role", label: "common.role", skeleton: "control" },
  {
    id: "billing",
    sortKey: null,
    label: "organization.members.billingAccess",
    skeleton: "control",
  },
  {
    id: "joined",
    sortKey: "joined",
    label: "organization.members.joined",
    skeleton: "text",
    secondary: true,
  },
  { id: "actions", sortKey: null, label: null, skeleton: "none" },
];

const isSecondaryMemberColumn = (id: MemberColumn["id"]) =>
  MEMBER_COLUMNS.some((column) => column.id === id && column.secondary);

/** A member row's cell, hidden on phones when its column is secondary. */
export const MemberTableCell = ({
  columnId,
  ...props
}: { columnId: MemberColumn["id"] } & Omit<
  ComponentProps<typeof TableCell>,
  "className"
>) => (
  <TableCell
    {...props}
    className={cn(isSecondaryMemberColumn(columnId) && SECONDARY_COLUMN_CLASS)}
  />
);

const noopSort = () => undefined;

// Real header and skeleton both map over MEMBER_COLUMNS, so adding, removing,
// or reordering a column updates both at once. Without `onSort` the heads are
// inert, as while the page loads.
const MembersTableHeader = ({
  sort,
  onSort,
}: {
  sort: Sort;
  onSort: ((key: SortKey) => void) | undefined;
}) => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        {MEMBER_COLUMNS.map((column) => {
          if (column.sortKey === null || column.label === null) {
            return (
              <TableHead
                className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
                key={column.id}
              />
            );
          }
          const sortKey = column.sortKey;
          return (
            <SortableHead
              className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
              key={column.id}
              onSort={onSort === undefined ? noopSort : () => onSort(sortKey)}
              sortDirection={sort.key === sortKey ? sort.dir : null}
            >
              {t(column.label)}
            </SortableHead>
          );
        })}
      </TableRow>
    </TableHeader>
  );
};

/** The heading over a members or invitations table. */
const MembersSectionHeading = ({ children }: { children: ReactNode }) => (
  <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
    {children}
  </h2>
);

/**
 * The members page's frame: the page header, then the active members table
 * under its toolbar, then the invitations. The loaded page and its pending
 * view render the same frame, so nothing moves when the members arrive.
 */
export const MembersShell = ({
  toolbar,
  sort,
  onSort,
  children,
  invitations,
}: {
  toolbar: ReactNode;
  sort: Sort;
  onSort?: (key: SortKey) => void;
  children: ReactNode;
  invitations: ReactNode;
}) => {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.membersDescription")}
        title={t("common.members")}
      />

      <section className="flex flex-col gap-2">
        <MembersSectionHeading>
          {t("settings.organization.activeMembers")}
        </MembersSectionHeading>
        <Frame>
          {toolbar}
          <Table>
            <MembersTableHeader onSort={onSort} sort={sort} />
            <TableBody>{children}</TableBody>
          </Table>
        </Frame>
      </section>

      {invitations}
    </>
  );
};

const MemberSkeletonCell = ({ shape }: { shape: MemberSkeletonShape }) => {
  if (shape === "identity") {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    );
  }
  if (shape === "control") {
    return <Skeleton className="h-8 w-32" />;
  }
  if (shape === "none") {
    return null;
  }
  return <Skeleton className="h-4 w-24" />;
};

// Skeleton body derived from MEMBER_COLUMNS: one cell per column, in order, so
// it stays aligned with both the real header and the real rows.
const MembersSkeletonRows = () =>
  Array.from({ length: MEMBERS_SKELETON_ROW_COUNT }, (_, row) => (
    <TableRow key={row}>
      {MEMBER_COLUMNS.map((column) => (
        <TableCell
          className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
          key={column.id}
        >
          <MemberSkeletonCell shape={column.skeleton} />
        </TableCell>
      ))}
    </TableRow>
  ));

// Inert toolbar matching OrganizationListToolbar's layout so the pending shell
// reserves the same space and the page does not jump when data resolves.
const MembersToolbarPlaceholder = () => {
  const t = useTranslations();

  return (
    <div className="border-border/60 flex items-center gap-2 border-b px-2 py-2">
      <InputGroup className="max-w-sm flex-1">
        <InputGroupInput disabled placeholder={t("common.search")} />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};

/** The sort the page opens with. */
export const INITIAL_MEMBERS_SORT: Sort = { key: "name", dir: "asc" };

/**
 * The members page while the organization loads: the members table chrome
 * with shimmer rows, and the invitations table chrome with a few shimmer rows.
 */
export const MembersPending = () => {
  const t = useTranslations();

  return (
    <MembersShell
      invitations={
        <section className="flex flex-col gap-2">
          <MembersSectionHeading>
            {t("settings.organization.pendingInvitations")}
          </MembersSectionHeading>
          <Frame>
            <Table>
              <InvitationsTableHeader />
              <TableBody>
                <InvitationsSkeletonRows />
              </TableBody>
            </Table>
          </Frame>
        </section>
      }
      sort={INITIAL_MEMBERS_SORT}
      toolbar={<MembersToolbarPlaceholder />}
    >
      <MembersSkeletonRows />
    </MembersShell>
  );
};
